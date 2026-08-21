const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { createKey, revokeAllForUser, revokeKey, getActiveKeys, getKeysByDiscordId, getStats } = require('./database');
const { createApi, pendingStates } = require('./api');
const crypto = require('crypto');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const API_PORT = parseInt(process.env.API_PORT || '3000');
const BASE_URL = process.env.BASE_URL || `https://auth-production-181a.up.railway.app`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const CHECK_INTERVAL = 5 * 60 * 1000;

async function checkMemberships() {
  console.log(`[Check] Running membership check at ${new Date().toISOString()}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('[Check] Guild not found');
    return;
  }

  const activeKeys = getActiveKeys();
  const uniqueUsers = [...new Set(activeKeys.map(k => k.discord_id))];

  let revoked = 0;
  for (const userId of uniqueUsers) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        revokeAllForUser(userId);
        revoked++;
        console.log(`[Check] Revoked keys for user ${userId} (left server)`);
      }
    } catch (err) {
      if (err.httpStatus === 10013 || err.httpStatus === 10007) {
        revokeAllForUser(userId);
        revoked++;
        console.log(`[Check] Revoked keys for user ${userId} (not found)`);
      }
    }
  }

  const stats = getStats();
  console.log(`[Check] Done. Revoked: ${revoked} | Active keys: ${stats.active} | Total: ${stats.total}`);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('genkey')
      .setDescription('Generate a new key for a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to generate key for').setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('days').setDescription('Days until expiry (0 = never)')),
    new SlashCommandBuilder()
      .setName('getkey')
      .setDescription('Get your personal key (must be in the server)'),
    new SlashCommandBuilder()
      .setName('revoke')
      .setDescription('Revoke a specific key')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('key').setDescription('The key to revoke').setRequired(true)),
    new SlashCommandBuilder()
      .setName('revokeall')
      .setDescription('Revoke all keys for a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to revoke all keys for').setRequired(true)),
    new SlashCommandBuilder()
      .setName('mykey')
      .setDescription('Show your active keys'),
    new SlashCommandBuilder()
      .setName('keystats')
      .setDescription('Show key system stats')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Post the authenticate button embed to a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel to post in').setRequired(true)),
  ];

  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('[Bot] Slash commands registered');
  } catch (err) {
    console.error('[Bot] Failed to register commands:', err);
  }
}

client.on('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  await registerCommands();
  checkMemberships();
  setInterval(checkMemberships, CHECK_INTERVAL);
  console.log(`[Bot] Membership checker running every ${CHECK_INTERVAL / 1000}s`);
});

client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const keys = getKeysByDiscordId(member.id);
  const active = keys.filter(k => !k.revoked && (!k.expires_at || k.expires_at > Date.now()));
  if (active.length > 0) {
    revokeAllForUser(member.id);
    console.log(`[Bot] Revoked ${active.length} key(s) for ${member.user.tag} (left server)`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'setup') {
    const channel = interaction.options.getChannel('channel');
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, true);
    setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

    const oauth2Url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + '/oauth2/callback')}&response_type=code&scope=identify&state=${state}`;

    const embed = new EmbedBuilder()
      .setTitle('Sky Auth')
      .setDescription('Click **Authenticate** to verify your Discord account and receive your key.')
      .setColor(0xC8D7E6);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Authenticate')
        .setStyle(ButtonStyle.Link)
        .setURL(oauth2Url)
    );
    await channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `Posted authenticate embed to <#${channel.id}>`, ephemeral: true });
  }

  if (commandName === 'genkey') {
    const user = interaction.options.getUser('user');
    const days = interaction.options.getInteger('days') ?? 30;
    const key = createKey(user.id, user.username, days);
    const expiry = days > 0 ? `Expires in ${days} days` : 'Never expires';

    await interaction.reply({
      content: `Key for <@${user.id}>:\n\`${key}\`\n${expiry}`,
      ephemeral: true,
    });
  }

  if (commandName === 'revoke') {
    const key = interaction.options.getString('key');
    const result = revokeKey(key);
    if (result.changes > 0) {
      await interaction.reply({ content: `Key \`${key}\` revoked.`, ephemeral: true });
    } else {
      await interaction.reply({ content: 'Key not found.', ephemeral: true });
    }
  }

  if (commandName === 'revokeall') {
    const user = interaction.options.getUser('user');
    const result = revokeAllForUser(user.id);
    await interaction.reply({
      content: `Revoked ${result.changes} key(s) for <@${user.id}>.`,
      ephemeral: true,
    });
  }

  if (commandName === 'mykey') {
    const keys = getKeysByDiscordId(interaction.user.id);
    if (keys.length === 0) {
      await interaction.reply({ content: 'You have no keys.', ephemeral: true });
      return;
    }
    const list = keys.map(k => {
      const status = k.revoked ? '❌ Revoked' : (k.expires_at && k.expires_at < Date.now() ? '⏰ Expired' : '✅ Active');
      const expiry = k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'Never';
      return `\`${k.key}\` — ${status} — Expires: ${expiry}`;
    }).join('\n');
    await interaction.reply({ content: list, ephemeral: true });
  }

  if (commandName === 'getkey') {
    const guild = client.guilds.cache.get(GUILD_ID);
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: 'You must be in the server to get a key.', ephemeral: true });
      return;
    }
    const existing = getKeysByDiscordId(interaction.user.id).find(k => !k.revoked && (!k.expires_at || k.expires_at > Date.now()));
    if (existing) {
      await interaction.user.send(`Your existing key:\n\`${existing.key}\`\nExpires: ${existing.expires_at ? new Date(existing.expires_at).toLocaleDateString() : 'Never'}`).catch(() => {});
      await interaction.reply({ content: 'Check your DMs! You already have an active key.', ephemeral: true });
      return;
    }
    const key = createKey(interaction.user.id, interaction.user.username, 30);
    await interaction.user.send(`Your Sky key:\n\`${key}\`\nExpires in 30 days.\nKeep this key private!`).catch(() => {});
    await interaction.reply({ content: 'Check your DMs for your key!', ephemeral: true });
  }

  if (commandName === 'keystats') {
    const stats = getStats();
    await interaction.reply({
      content: `**Key Stats**\nTotal: ${stats.total}\nActive: ${stats.active}\nRevoked: ${stats.revoked}`,
      ephemeral: true,
    });
  }
});

client.login(TOKEN);
createApi(API_PORT, client, GUILD_ID, CLIENT_ID, CLIENT_SECRET);

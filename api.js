const express = require('express');
const { validateKey, createKey, getKeysByDiscordId } = require('./database');

const pendingStates = new Map();

function createApi(port, client, guildId, clientId, clientSecret) {
  const app = express();

  app.get('/check', (req, res) => {
    const { key } = req.query;
    if (!key) return res.json({ valid: false, message: 'No key provided' });
    return res.json(validateKey(key));
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  app.get('/oauth2/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.send('Missing authorization code or state.');
    }

    if (!pendingStates.has(state)) {
      return res.send('Invalid or expired authentication session. Go back to Discord and click Authenticate again.');
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.BASE_URL + '/oauth2/callback',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return res.send('Failed to exchange authorization code. Try again.');
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json();
      const userId = userData.id;

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return res.send('Bot guild not found. Contact an admin.');
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        return res.send('You are not in the server. Join first, then authenticate again.');
      }

      const existing = getKeysByDiscordId(userId)
        .find(k => !k.revoked && (!k.expires_at || k.expires_at > Date.now()));
      let key;
      if (existing) {
        key = existing.key;
      } else {
        key = createKey(userId, userData.username || member.user.username, 30);
      }

      await member.send(`Your Sky key:\n\`${key}\`\nExpires in 30 days.\nKeep this key private!`).catch(() => {});

      res.send(`
        <html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center">
            <h1>Authenticated</h1>
            <p>Your key has been sent to your Discord DMs.</p>
            <p>You can close this tab.</p>
          </div>
        </body></html>
      `);
      console.log(`[OAuth] Authenticated ${member.user.tag}, key DM'd`);
    } catch (err) {
      console.error('[OAuth] Error:', err);
      res.send('Something went wrong. Try again.');
    }
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`[API] Listening on port ${port}`);
  });

  return app;
}

module.exports = { createApi, pendingStates };

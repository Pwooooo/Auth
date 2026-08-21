const express = require('express');
const { validateKey } = require('./database');

function createApi(port, apiKey) {
  const app = express();
  app.use(express.json());

  app.get('/check', (req, res) => {
    const { key, userid } = req.query;

    if (!key) {
      return res.json({ valid: false, message: 'No key provided' });
    }

    const result = validateKey(key);
    return res.json(result);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`[API] Listening on port ${port}`);
  });

  return app;
}

module.exports = { createApi };

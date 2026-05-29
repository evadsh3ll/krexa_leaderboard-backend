// PM2 process map for the Krexa bill-challenge bot.
//   pm2 start ecosystem.config.cjs
//   pm2 logs krexa-bill-bot
//   pm2 save && pm2 startup
//
// Assumes a logged-in Chrome is already running with --remote-debugging-port=9222
// (see README "Chrome on the VPS"). This process scrapes on a loop AND serves
// the leaderboard over HTTP.
module.exports = {
  apps: [
    {
      name: 'krexa-bill-bot',
      script: 'node_modules/.bin/tsx',
      args: 'src/run.ts --watch',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
    },
  ],
};

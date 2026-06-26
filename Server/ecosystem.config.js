module.exports = {
  apps: [{
    name: 'switch-installer',
    script: './src/server.js',
    cwd: '/data/SwitchInstaller',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 18080,
      HOST: '0.0.0.0',
    },
    error_file: '/data/SwitchInstaller/logs/err.log',
    out_file: '/data/SwitchInstaller/logs/out.log',
    log_file: '/data/SwitchInstaller/logs/combined.log',
    time: true,
    kill_timeout: 5000,
    listen_timeout: 5000,
  }],
};

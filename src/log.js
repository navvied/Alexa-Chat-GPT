// One line per event, readable in journalctl. Never pass secrets in `fields`.

function write(stream, level, message, fields) {
  const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  stream.write(`${new Date().toISOString()} ${level} ${message}${extra}\n`);
}

export const log = {
  info: (message, fields) => write(process.stdout, 'INFO', message, fields),
  warn: (message, fields) => write(process.stderr, 'WARN', message, fields),
  error: (message, fields) => write(process.stderr, 'ERROR', message, fields),
};

export const silentLog = { info() {}, warn() {}, error() {} };

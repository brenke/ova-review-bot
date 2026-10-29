const LEVEL_COLORS = {
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  debug: '\u001b[90m',
};
const RESET = '\u001b[0m';

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, scope, args) {
  const color = LEVEL_COLORS[level] ?? '';
  const prefix = `${stamp()} ${color}${level.toUpperCase().padEnd(5)}${RESET} [${scope}]`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(prefix, ...args);
}

export function createLogger(scope) {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
  };
}

export const logger = createLogger('bot');

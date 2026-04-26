export interface Logger {
  service: string;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  function write(level: string, message: string, fields?: Record<string, unknown>) {
    const payload = {
      level,
      service,
      message,
      ...fields
    };
    console.log(JSON.stringify(payload));
  }

  return {
    service,
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    }
  };
}


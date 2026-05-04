export const logger = {
  info: (msg: string | object, detail?: string) => {
    if (typeof msg === "object") {
      console.log(`[INFO] ${detail || ""}`, JSON.stringify(msg, null, 2));
    } else {
      console.log(`[INFO] ${msg}`);
    }
  },
  warn: (msg: string | object, detail?: string) => {
    console.warn(`[WARN] ${detail || ""}`, msg);
  },
  error: (msg: string | object, detail?: string) => {
    console.error(`[ERROR] ${detail || ""}`, msg);
  }
};
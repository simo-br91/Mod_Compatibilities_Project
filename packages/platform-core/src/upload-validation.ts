import type { UploadValidationResult } from "@modcompat/api-contracts";

const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_MIME_TYPES = new Set([
  "application/java-archive",
  "application/zip",
  "application/json",
  "application/octet-stream"
]);

// Magic byte signatures for MIME detection
function detectMimeType(buffer: Uint8Array): string {
  // ZIP / JAR: PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return "application/java-archive";
  }
  // Java class file: 0xCAFEBABE
  if (buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && buffer[3] === 0xbe) {
    return "application/java-archive";
  }
  // JSON: leading { or [
  const first = buffer[0];
  if (first === 0x7b || first === 0x5b) {
    return "application/json";
  }
  return "application/octet-stream";
}

// Malware signatures checked at byte offset 0
function hasMalwareSignature(buffer: Uint8Array): boolean {
  // Windows PE executable: MZ header (0x4D 0x5A)
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return true;
  }
  // ELF binary: \x7fELF (0x7F 0x45 0x4C 0x46)
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    return true;
  }
  return false;
}

export interface UploadValidationConfig {
  maxFileSizeBytes?: number;
  allowedMimeTypes?: Set<string>;
}

export class UploadValidationService {
  private readonly maxFileSizeBytes: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(config: UploadValidationConfig = {}) {
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    this.allowedMimeTypes = config.allowedMimeTypes ?? ALLOWED_MIME_TYPES;
  }

  validate(buffer: Uint8Array, declaredMimeType?: string): UploadValidationResult {
    const fileSizeBytes = buffer.byteLength;

    if (fileSizeBytes > this.maxFileSizeBytes) {
      return {
        valid: false,
        fileSizeBytes,
        declaredMimeType,
        rejectionReason: "size_exceeded"
      };
    }

    if (hasMalwareSignature(buffer)) {
      return {
        valid: false,
        fileSizeBytes,
        declaredMimeType,
        rejectionReason: "malware_signature"
      };
    }

    const detectedMimeType = detectMimeType(buffer);

    if (!this.allowedMimeTypes.has(detectedMimeType)) {
      return {
        valid: false,
        fileSizeBytes,
        declaredMimeType,
        detectedMimeType,
        rejectionReason: "disallowed_type"
      };
    }

    if (declaredMimeType && declaredMimeType !== detectedMimeType) {
      // Allow zip/jar interchangeably since JARs are ZIPs
      const isJarZipAlias =
        (declaredMimeType === "application/zip" &&
          detectedMimeType === "application/java-archive") ||
        (declaredMimeType === "application/java-archive" &&
          detectedMimeType === "application/java-archive");
      if (!isJarZipAlias) {
        return {
          valid: false,
          fileSizeBytes,
          declaredMimeType,
          detectedMimeType,
          rejectionReason: "mime_mismatch"
        };
      }
    }

    return {
      valid: true,
      fileSizeBytes,
      declaredMimeType,
      detectedMimeType
    };
  }
}

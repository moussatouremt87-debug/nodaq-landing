import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/*
 * Object Storage du support (2.18) : corps d'e-mails et pièces jointes vivent
 * ICI (fr-par en prod, MinIO en local) — JAMAIS en base (décision n°6 du
 * ticket) et jamais dans les logs. Secrets absents => canal support désactivé
 * proprement (même pattern de dégradation que les clés VAPID du 2.17).
 */

export interface SupportStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
}

export function createSupportStorage(env: NodeJS.ProcessEnv = process.env): SupportStorage | null {
  const endpoint = env.SUPPORT_S3_ENDPOINT;
  const bucket = env.SUPPORT_S3_BUCKET;
  const accessKeyId = env.SUPPORT_S3_ACCESS_KEY;
  const secretAccessKey = env.SUPPORT_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const client = new S3Client({
    endpoint,
    region: env.SUPPORT_S3_REGION ?? "fr-par",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // MinIO local + Scaleway acceptent le path-style
  });
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await result.Body?.transformToByteArray();
        if (!bytes) return null;
        return { body: bytes, contentType: result.ContentType ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },
  };
}

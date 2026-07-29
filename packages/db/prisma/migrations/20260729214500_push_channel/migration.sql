-- 2.17 (spec amendée) : canal de livraison par subscription — WEBPUSH
-- aujourd'hui, FCM/APNS avec les app stores (T.11).
ALTER TABLE "push_subscriptions" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'WEBPUSH';

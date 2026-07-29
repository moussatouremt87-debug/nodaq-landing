-- Défense en profondeur (audit) : l'enum de canal est applicative (Zod),
-- le CHECK empêche une valeur arbitraire par un DML/seed futur.
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_channel_check"
  CHECK ("channel" IN ('WEBPUSH', 'FCM', 'APNS'));

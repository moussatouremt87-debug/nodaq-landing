-- Défense en profondeur (audit 3.5) : une ligne hors bornes serait
-- silencieusement exclue du plan par le safeParse applicatif.
ALTER TABLE "staff_members"
  ADD CONSTRAINT "staff_members_weekly_hours_check"
  CHECK ("weekly_hours" BETWEEN 0 AND 80);

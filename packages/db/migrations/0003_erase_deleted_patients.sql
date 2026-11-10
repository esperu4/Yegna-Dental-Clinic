DROP INDEX `patients_phone_uq`;--> statement-breakpoint
-- Patients deleted before this change are erased too (docs/adr/0007).
UPDATE `patients` SET `name` = '', `phone_e164` = '', `note` = NULL, `telegram_chat_id` = NULL, `telegram_linked_at` = NULL WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
UPDATE `audit_log` SET `diff` = NULL WHERE `entity` = 'patients' AND `entity_id` IN (SELECT `id` FROM `patients` WHERE `deleted_at` IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `patients_phone_uq` ON `patients` (`phone_e164`) WHERE "patients"."deleted_at" IS NULL;

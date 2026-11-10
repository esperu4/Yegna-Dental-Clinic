-- Completes 0003 for patients deleted before the erase rule (docs/adr/0007): their bookings' free
-- text, the values in those bookings' audit history (including refused bookings made for them),
-- and the values of every refused patient op (they are not tied to the patient's id).
UPDATE `audit_log` SET `diff` = NULL WHERE `entity` = 'patients' AND `action` LIKE 'rejected:%';--> statement-breakpoint
UPDATE `audit_log` SET `diff` = json_remove(`diff`, '$.note', '$.cancelReason', '$.fields.note', '$.fields.cancelReason') WHERE `entity` = 'bookings' AND `diff` IS NOT NULL AND (`entity_id` IN (SELECT `b`.`id` FROM `bookings` `b` JOIN `patients` `p` ON `p`.`id` = `b`.`patient_id` WHERE `p`.`deleted_at` IS NOT NULL) OR json_extract(`diff`, '$.fields.patientId') IN (SELECT `id` FROM `patients` WHERE `deleted_at` IS NOT NULL));--> statement-breakpoint
-- Changed bookings take a new version, so devices pull the cleared notes (ADR 0006).
INSERT INTO `sync_seq` (`id`, `value`) VALUES (1, 1) ON CONFLICT(`id`) DO UPDATE SET `value` = `value` + 1;--> statement-breakpoint
UPDATE `bookings` SET `note` = NULL, `cancel_reason` = NULL, `version` = (SELECT `value` FROM `sync_seq` WHERE `id` = 1) WHERE `patient_id` IN (SELECT `id` FROM `patients` WHERE `deleted_at` IS NOT NULL) AND (`note` IS NOT NULL OR `cancel_reason` IS NOT NULL);

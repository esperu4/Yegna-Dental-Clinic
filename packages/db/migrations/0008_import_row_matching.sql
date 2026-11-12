ALTER TABLE `import_rows` ADD `day_text` text;--> statement-breakpoint
ALTER TABLE `import_rows` ADD `start_at` integer;--> statement-breakpoint
ALTER TABLE `import_rows` ADD `patient_id` text;--> statement-breakpoint
ALTER TABLE `import_rows` ADD `duplicate_of_id` text;--> statement-breakpoint
ALTER TABLE `import_rows` ADD `needs_check` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_import_row_uq` ON `bookings` (`import_row_id`) WHERE "bookings"."import_row_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `imports_uploader_created_idx` ON `imports` (`uploaded_by`,`created_at`);
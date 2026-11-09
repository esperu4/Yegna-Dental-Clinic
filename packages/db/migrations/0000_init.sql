CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`user_id` text,
	`device_id` text,
	`action` text NOT NULL,
	`diff` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`reason` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	CONSTRAINT "blocks_range" CHECK("blocks"."end_at" > "blocks"."start_at")
);
--> statement-breakpoint
CREATE INDEX `blocks_start_idx` ON `blocks` (`start_at`);--> statement-breakpoint
CREATE INDEX `blocks_version_idx` ON `blocks` (`version`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`patient_id` text NOT NULL,
	`procedure_id` text,
	`start_at` integer NOT NULL,
	`duration_min` integer NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`patient_confirmed_at` integer,
	`source` text DEFAULT 'app' NOT NULL,
	`import_row_id` text,
	`cancel_reason` text,
	`clash_with_id` text,
	`note` text,
	`created_by` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedures`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bookings_duration_grid" CHECK("bookings"."duration_min" > 0 AND "bookings"."duration_min" % 15 = 0)
);
--> statement-breakpoint
CREATE INDEX `bookings_start_idx` ON `bookings` (`start_at`);--> statement-breakpoint
CREATE INDEX `bookings_patient_start_idx` ON `bookings` (`patient_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `bookings_version_idx` ON `bookings` (`version`);--> statement-breakpoint
CREATE INDEX `bookings_status_start_idx` ON `bookings` (`status`,`start_at`);--> statement-breakpoint
CREATE TABLE `day_rules` (
	`date` text PRIMARY KEY NOT NULL,
	`open_at` integer,
	`close_at` integer,
	`lunch_start` integer,
	`lunch_end` integer,
	`closed` integer DEFAULT false NOT NULL,
	`note` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `day_rules_version_idx` ON `day_rules` (`version`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_uq` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`name_am` text NOT NULL,
	`name_en` text NOT NULL,
	`closed` integer DEFAULT true NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `holidays_date_idx` ON `holidays` (`date`);--> statement-breakpoint
CREATE INDEX `holidays_version_idx` ON `holidays` (`version`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`time_text` text,
	`name_text` text,
	`phone_text` text,
	`code_text` text,
	`confidence` integer,
	`match` text,
	`decision` text,
	`booking_id` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_rows_import_idx` ON `import_rows` (`import_id`);--> statement-breakpoint
CREATE INDEX `import_rows_version_idx` ON `import_rows` (`version`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_file_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`template` text,
	`period_label` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider` text,
	`raw_result` text,
	`created_at` integer NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `imports_status_idx` ON `imports` (`status`);--> statement-breakpoint
CREATE INDEX `imports_version_idx` ON `imports` (`version`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_chat_id` text NOT NULL,
	`booking_id` text DEFAULT '' NOT NULL,
	`sent_at` integer,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_log_idem_uq` ON `notification_log` (`kind`,`booking_id`,`target_chat_id`);--> statement-breakpoint
CREATE INDEX `notification_log_status_idx` ON `notification_log` (`status`);--> statement-breakpoint
CREATE TABLE `patient_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`patient_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`handled_by` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `patient_requests_status_idx` ON `patient_requests` (`status`);--> statement-breakpoint
CREATE INDEX `patient_requests_version_idx` ON `patient_requests` (`version`);--> statement-breakpoint
CREATE TABLE `patients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone_e164` text NOT NULL,
	`note` text,
	`telegram_chat_id` text,
	`telegram_linked_at` integer,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	CONSTRAINT "patients_note_len" CHECK("patients"."note" IS NULL OR length("patients"."note") <= 280)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patients_phone_uq` ON `patients` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `patients_name_idx` ON `patients` (`name`);--> statement-breakpoint
CREATE INDEX `patients_version_idx` ON `patients` (`version`);--> statement-breakpoint
CREATE TABLE `procedures` (
	`id` text PRIMARY KEY NOT NULL,
	`name_am` text NOT NULL,
	`name_en` text NOT NULL,
	`code` text NOT NULL,
	`duration_min` integer NOT NULL,
	`color` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	CONSTRAINT "procedures_code_len" CHECK(length("procedures"."code") BETWEEN 1 AND 3),
	CONSTRAINT "procedures_duration_grid" CHECK("procedures"."duration_min" > 0 AND "procedures"."duration_min" % 15 = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `procedures_code_uq` ON `procedures` (`code`);--> statement-breakpoint
CREATE INDEX `procedures_version_idx` ON `procedures` (`version`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`weekly_hours` text NOT NULL,
	`unspecified_duration_min` integer DEFAULT 60 NOT NULL,
	`patient_reminder_at` integer DEFAULT 1080 NOT NULL,
	`doctor_summary_at` integer DEFAULT 1140 NOT NULL,
	`default_template` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `sync_ops` (
	`op_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`result` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_ops_applied_at_idx` ON `sync_ops` (`applied_at`);--> statement-breakpoint
CREATE TABLE `sync_seq` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`pin_hash` text,
	`pin_salt` text,
	`locale` text DEFAULT 'am' NOT NULL,
	`calendar` text DEFAULT 'ethiopian' NOT NULL,
	`telegram_chat_id` text,
	`disabled_at` integer,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `users_version_idx` ON `users` (`version`);
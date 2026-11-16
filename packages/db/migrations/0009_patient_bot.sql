ALTER TABLE `patients` ADD `telegram_locale` text;--> statement-breakpoint
CREATE INDEX `patients_telegram_chat_idx` ON `patients` (`telegram_chat_id`);
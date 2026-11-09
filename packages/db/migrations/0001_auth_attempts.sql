CREATE TABLE `auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`locks` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_ticket` text,
	`updated_at` integer NOT NULL
);

CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`public_key` text NOT NULL,
	`version` text,
	`os` text,
	`arch` text,
	`hostname` text,
	`interfaces` text,
	`connected` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`enrolled_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`auto_update` integer DEFAULT false NOT NULL,
	`update_status` text,
	`latest_version` text,
	`last_update_error` text,
	`update_checked_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_deviceId_unique` ON `agents` (`device_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text NOT NULL,
	`ups_ids` text,
	`device_ids` text,
	`title_template` text,
	`body_template` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`outage_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`sent_at` integer,
	`acked_at` integer,
	`expires_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commands_agent_status_idx` ON `commands` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_status_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_event_idx` ON `deliveries` (`event_id`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text,
	`mac` text,
	`ups_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`shutdown_enabled` integer DEFAULT false NOT NULL,
	`shutdown_battery_percent` integer DEFAULT 20 NOT NULL,
	`shutdown_runtime_sec` integer,
	`wake_enabled` integer DEFAULT true NOT NULL,
	`always_wake` integer DEFAULT false NOT NULL,
	`online` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ups_id`) REFERENCES `ups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_tokens_tokenHash_unique` ON `enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`ups_id` text,
	`device_id` text,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `outage_devices` (
	`outage_id` text NOT NULL,
	`device_id` text NOT NULL,
	`was_online` integer DEFAULT false NOT NULL,
	`shutdown_command_id` text,
	`shutdown_sent_at` integer,
	`shutdown_acked_at` integer,
	`shutdown_error` text,
	`shutdown_failure_notified` integer DEFAULT false NOT NULL,
	`wake_attempts` integer DEFAULT 0 NOT NULL,
	`last_wake_at` integer,
	`recovered_at` integer,
	`wake_gave_up_at` integer,
	PRIMARY KEY(`outage_id`, `device_id`),
	FOREIGN KEY (`outage_id`) REFERENCES `outages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outages` (
	`id` text PRIMARY KEY NOT NULL,
	`ups_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`min_battery` integer,
	`low_battery` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`ups_id`) REFERENCES `ups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outages_ups_idx` ON `outages` (`ups_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 3493 NOT NULL,
	`ups_name` text NOT NULL,
	`username` text,
	`password_enc` text,
	`enabled` integer DEFAULT true NOT NULL,
	`reachable` integer DEFAULT false NOT NULL,
	`status` text,
	`battery` integer,
	`runtime` integer,
	`load` integer,
	`input_voltage` real,
	`model` text,
	`last_polled_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ups_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ups_id` text NOT NULL,
	`ts` integer NOT NULL,
	`status` text,
	`battery` integer,
	`runtime` integer,
	`load` integer,
	`input_voltage` real,
	FOREIGN KEY (`ups_id`) REFERENCES `ups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ups_samples_ups_ts_idx` ON `ups_samples` (`ups_id`,`ts`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);

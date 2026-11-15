CREATE TABLE `nut_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`online` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`os` text,
	`package_manager` text,
	`nut_version` text,
	`config_dir` text,
	`listen_address` text,
	`local_shutdown` integer DEFAULT false NOT NULL,
	`services` text,
	`problems` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Migrations run in a transaction, where foreign_keys=OFF has no effect, so dropping agents cascades to commands.
-- Keep a copy and put the rows back once agents is rebuilt.
CREATE TABLE `__commands_backup` AS SELECT * FROM `commands`;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'device' NOT NULL,
	`device_id` text,
	`nut_host_id` text,
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
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nut_host_id`) REFERENCES `nut_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "kind", "device_id", "nut_host_id", "public_key", "version", "os", "arch", "hostname", "interfaces", "connected", "last_seen_at", "enrolled_at", "auto_update", "update_status", "latest_version", "last_update_error", "update_checked_at") SELECT "id", 'device', "device_id", NULL, "public_key", "version", "os", "arch", "hostname", "interfaces", "connected", "last_seen_at", "enrolled_at", "auto_update", "update_status", "latest_version", "last_update_error", "update_checked_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_deviceId_unique` ON `agents` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_nutHostId_unique` ON `agents` (`nut_host_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `commands` SELECT * FROM `__commands_backup`;--> statement-breakpoint
DROP TABLE `__commands_backup`;--> statement-breakpoint
CREATE TABLE `__new_enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text,
	`nut_host_id` text,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nut_host_id`) REFERENCES `nut_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_enrollment_tokens`("id", "device_id", "nut_host_id", "token_hash", "expires_at", "used_at", "created_at") SELECT "id", "device_id", NULL, "token_hash", "expires_at", "used_at", "created_at" FROM `enrollment_tokens`;--> statement-breakpoint
DROP TABLE `enrollment_tokens`;--> statement-breakpoint
ALTER TABLE `__new_enrollment_tokens` RENAME TO `enrollment_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_tokens_tokenHash_unique` ON `enrollment_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `ups` ADD `nut_host_id` text REFERENCES nut_hosts(id) ON DELETE set null;
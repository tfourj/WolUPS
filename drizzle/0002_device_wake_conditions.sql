ALTER TABLE `devices` ADD `wake_delay_sec` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `wake_min_battery_percent` integer;--> statement-breakpoint
ALTER TABLE `outage_devices` ADD `first_wake_at` integer;
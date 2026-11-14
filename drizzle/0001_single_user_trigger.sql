-- WolUPS is single user. SQLite serializes writes, so this trigger makes the
-- first-account check race-safe even if two registrations arrive together.
CREATE TRIGGER IF NOT EXISTS `user_single_account`
BEFORE INSERT ON `user`
WHEN (SELECT COUNT(*) FROM `user`) >= 1
BEGIN
  SELECT RAISE(ABORT, 'registration closed');
END;

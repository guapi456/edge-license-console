ALTER TABLE licenses ADD COLUMN key_ciphertext TEXT;
ALTER TABLE licenses ADD COLUMN key_iv TEXT;
ALTER TABLE licenses ADD COLUMN key_encryption_version INTEGER NOT NULL DEFAULT 1;

-- Interface languages of every Grab market (plus Russian).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('en','th','vi','id','ms','fil','km','my','zh','ru'));

-- Account deletion must remove the whole order history in one statement.
-- Make every FK inside a user's data tree cascade (or null out), so ordering of cascades cannot fail.
ALTER TABLE cart_versions DROP CONSTRAINT cart_versions_address_id_fkey,
  ADD CONSTRAINT cart_versions_address_id_fkey FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL;
ALTER TABLE checkouts DROP CONSTRAINT checkouts_quote_id_fkey,
  ADD CONSTRAINT checkouts_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;
ALTER TABLE submission_attempts DROP CONSTRAINT submission_attempts_checkout_id_fkey,
  ADD CONSTRAINT submission_attempts_checkout_id_fkey FOREIGN KEY (checkout_id) REFERENCES checkouts(id) ON DELETE CASCADE;
ALTER TABLE orders DROP CONSTRAINT orders_checkout_id_fkey,
  ADD CONSTRAINT orders_checkout_id_fkey FOREIGN KEY (checkout_id) REFERENCES checkouts(id) ON DELETE CASCADE;
ALTER TABLE orders DROP CONSTRAINT orders_submission_id_fkey,
  ADD CONSTRAINT orders_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submission_attempts(id) ON DELETE CASCADE;
ALTER TABLE orders DROP CONSTRAINT orders_cart_id_fkey,
  ADD CONSTRAINT orders_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE;

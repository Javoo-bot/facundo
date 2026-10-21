-- Migration: add radius_km to cities for radius-based (circle) scraping.
-- Safe to run once on a project already created from the original schema.sql.
-- Existing rows get radius_km = null (ingested before radius-based scraping
-- existed); the dashboard should show "—" for those. New/re-ingested rows
-- get the radius_km used for that ingest via db.get_or_create_city.

alter table cities add column if not exists radius_km double precision;

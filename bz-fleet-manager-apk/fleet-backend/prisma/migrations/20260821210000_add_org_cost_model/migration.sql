-- Org-level cost model (Money screen): the four RateConfig knobs that price
-- estCost/margin at commit time. Defaults match DEFAULT_RATE_CONFIG so
-- existing orgs keep pricing exactly as before.
ALTER TABLE "Org"
  ADD COLUMN "mpg" DOUBLE PRECISION NOT NULL DEFAULT 6.5,
  ADD COLUMN "dieselCentsPerGal" INTEGER NOT NULL DEFAULT 400,
  ADD COLUMN "driverPayCentsPerMi" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "fixedCentsPerMi" INTEGER NOT NULL DEFAULT 45;

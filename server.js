
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

const {
  PORT = 3000,
  ODOO_URL,
  ODOO_API_KEY,
  ALLOWED_ORIGIN
} = process.env;

if (!ODOO_URL || !ODOO_API_KEY || !ALLOWED_ORIGIN) {
  throw new Error("Missing environment configuration");
}

const publicIds = (process.env.PUBLIC_PROGRAM_IDS || "")
  .split(",")
  .map(Number)
  .filter(Number.isSafeInteger);

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use(express.json({ limit: "16kb" }));

async function odooSearchRead(model, domain, fields) {
  const response = await fetch(
    `${ODOO_URL}/json/2/${model}/search_read`,
    {
      method: "POST",
      headers: {
        Authorization: `bearer ${ODOO_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        domain,
        fields,
        limit: 100
      }),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error(`Odoo API error: ${response.status}`);
  }

  return response.json();
}


app.get("/api/public-offers", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=60");

    if (!publicIds.length) {
      return res.json({ offers: [] });
    }

    const [programs, rules, rewards] = await Promise.all([
      odooSearchRead(
        "loyalty.program",
        [
          ["id", "in", publicIds],
          ["active", "=", true]
        ],
        ["id", "name", "program_type"]
      ),

      odooSearchRead(
        "loyalty.rule",
        [["program_id", "in", publicIds]],
        [
          "id",
          "program_id",
          "minimum_qty",
          "minimum_amount",
          "product_ids",
          "product_category_id"
        ]
      ),

      odooSearchRead(
        "loyalty.reward",
        [["program_id", "in", publicIds]],
        [
          "id",
          "program_id",
          "reward_type",
          "discount",
          "discount_mode",
          "discount_applicability",
          "discount_max_amount"
        ]
      )
    ]);

    const relationId = value =>
      Array.isArray(value) ? value[0] : null;

    const offers = programs.map(program => {
      const programRules = rules.filter(
        rule => relationId(rule.program_id) === program.id
      );

      const programRewards = rewards.filter(
        reward => relationId(reward.program_id) === program.id
      );

      return {
        id: program.id,
        name: program.name,
        type: program.program_type,
        rules: programRules.map(rule => ({
          minimum_qty: rule.minimum_qty,
          minimum_amount: rule.minimum_amount,
          product_ids: rule.product_ids,
          product_category_id: rule.product_category_id
        })),
        rewards: programRewards.map(reward => ({
          type: reward.reward_type,
          discount: reward.discount,
          mode: reward.discount_mode,
          applies_to: reward.discount_applicability,
          max_discount: reward.discount_max_amount
        })),
        status: "conditions_not_evaluated"
      };
    });

    res.json({ offers });

  } catch (error) {
    console.error("Failed to fetch public offers:", error.message);
    res.status(502).json({
      error: "Cannot load promotions right now"
    });
  }
});


app.listen(PORT, () => {
  console.log(`TM Sport API running on port ${PORT}`);
});

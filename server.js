
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("node:path");

const app = express();

const {
    PORT = 3000,
    ODOO_URL,
    ODOO_API_KEY,
    ALLOWED_ORIGIN
} = process.env;

// ==========================================
// 1. KIEM TRA CAU HINH
// ==========================================

if (!ODOO_URL || !ODOO_API_KEY || !ALLOWED_ORIGIN) {
    throw new Error("Missing environment configuration");
}

const PUBLIC_PROGRAM_TYPES = [
    "promo_code",
    "promotion",
    "coupons",
    "next_order_coupons"
];


// ==========================================
// 2. MIDDLEWARE
// ==========================================

app.use(helmet());

app.use(cors({
    origin: ALLOWED_ORIGIN
}));

app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false
}));

app.use(express.json({
    limit: "16kb"
}));

// ==========================================
// 3. STATIC JAVASCRIPT
// ==========================================

app.use(
    "/assets",
    express.static(
        path.join(__dirname, "public"),
        {
            maxAge: "5m",
            immutable: false,

            setHeaders: (res, filePath) => {
                if (filePath.endsWith("tms-offers.js")) {
                    res.setHeader(
                        "Cross-Origin-Resource-Policy",
                        "cross-origin"
                    );

                    res.setHeader(
                        "Access-Control-Allow-Origin",
                        ALLOWED_ORIGIN
                    );
                }
            }
        }
    )
);

// ==========================================
// 4. HAM GOI ODOO JSON-2 API
// ==========================================

async function odooSearchRead(model, domain, fields) {
    const response = await fetch(
        `${ODOO_URL.replace(/\/$/, "")}/json/2/${model}/search_read`,
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
        throw new Error(
            `Odoo API error ${response.status} on ${model}`
        );
    }

    return response.json();
}

// ==========================================
// 5. TU DONG LAY CHUONG TRINH
// ==========================================

async function getPublicPrograms() {
    return odooSearchRead(
        "loyalty.program",
        [
            ["active", "=", true],
            [
                "program_type",
                "in",
                PUBLIC_PROGRAM_TYPES
            ]
        ],
        [
            "id",
            "name",
            "program_type"
        ]
    );
}

// ==========================================
// 6. LAY RULES VA REWARDS
// ==========================================

async function getPromotionData() {
    const programs = await getPublicPrograms();

    const programIds = programs.map(
        program => program.id
    );

    if (programIds.length === 0) {
        return {
            programs: [],
            rules: [],
            rewards: []
        };
    }

    const [rules, rewards] = await Promise.all([
        odooSearchRead(
            "loyalty.rule",
            [["program_id", "in", programIds]],
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
            [["program_id", "in", programIds]],
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

    return {
        programs,
        rules,
        rewards
    };
}

// ==========================================
// 7. HELPER
// ==========================================

function relationId(value) {
    return Array.isArray(value)
        ? value[0]
        : (Number.isInteger(value) ? value : null);
}

function getRulesForProgram(rules, programId) {
    return rules.filter(
        rule => relationId(rule.program_id) === programId
    );
}

function getRewardsForProgram(rewards, programId) {
    return rewards.filter(
        reward => relationId(reward.program_id) === programId
    );
}

function formatRewards(rewards) {
    return rewards.map(reward => ({
        type: reward.reward_type,
        discount: reward.discount,
        mode: reward.discount_mode,
        applies_to: reward.discount_applicability,
        maxDiscount: reward.discount_max_amount
    }));
}

// ==========================================
// 8. API DANH SACH CHUONG TRINH
// GET /api/public-offers
// ==========================================

app.get("/api/public-offers", async (req, res) => {
    try {
        res.set(
            "Cache-Control",
            "public, max-age=60"
        );

        const {
            programs,
            rules,
            rewards
        } = await getPromotionData();

        const offers = programs.map(program => {
            const programRules = getRulesForProgram(
                rules,
                program.id
            );

            const programRewards = getRewardsForProgram(
                rewards,
                program.id
            );

            return {
                id: program.id,
                name: program.name,
                type: program.program_type,

                rules: programRules.map(rule => ({
                    minimum_qty: rule.minimum_qty,
                    minimum_amount: rule.minimum_amount,
                    product_ids: rule.product_ids,
                    product_category_id:
                        rule.product_category_id
                })),

                requiresCoupon,

                eligibilityVerified: false,

                rewards: formatRewards(programRewards),

                status: "conditions_not_evaluated"
            };
        });

        return res.json({ offers });

    } catch (error) {
        console.error(
            "Failed to fetch public offers:",
            error.message
        );

        return res.status(502).json({
            error: "Cannot load promotions right now"
        });
    }
});

// ==========================================
// 9. API KIEM TRA DIEU KIEN GIO HANG
// POST /api/offers/preview
// ==========================================

app.post("/api/offers/preview", async (req, res) => {
    try {
        const {
            cartAmount,
            cartQuantity
        } = req.body || {};

        // Kiem tra du lieu dau vao
        if (
            !Number.isFinite(cartAmount) ||
            !Number.isSafeInteger(cartQuantity) ||
            cartAmount < 0 ||
            cartQuantity < 0
        ) {
            return res.status(400).json({
                error: "Invalid cart amount or quantity"
            });
        }

        res.set("Cache-Control", "no-store");

        const {
            programs,
            rules,
            rewards
        } = await getPromotionData();

        const offers = programs.map(program => {
            const programRules = getRulesForProgram(
                rules,
                program.id
            );

            const programRewards = getRewardsForProgram(
                rewards,
                program.id
            );

            // Chi uoc tinh cac rule don gian
            // khong gioi han san pham/danh muc
            const simpleRules = programRules.filter(rule =>
                !rule.product_ids?.length &&
                !rule.product_category_id
            );

            const needsMoreChecks =
                programRules.length !== 1 ||
                simpleRules.length !== 1;

            const rule = simpleRules[0];

            const minimumAmount =
                rule?.minimum_amount ?? 0;

            const minimumQuantity =
                rule?.minimum_qty ?? 0;

            const missingAmount = Math.max(
                0,
                minimumAmount - cartAmount
            );

            const missingQuantity = Math.max(
                0,
                minimumQuantity - cartQuantity
            );

            const meetsSimpleMinimum =
                !needsMoreChecks &&
                missingAmount === 0 &&
                missingQuantity === 0;


            let status;

            const requiresCoupon = [
                "promo_code",
                "coupons",
                "next_order_coupons"
            ].includes(program.program_type);

            if (program.program_type === "next_order_coupons") {
                status = "next_order_offer";
            } else if (needsMoreChecks) {
                status = "requires_additional_checks";
            } else if (meetsSimpleMinimum) {
                status = "minimum_met";
            } else {
                status = "minimum_not_met";
            }


            return {
                id: program.id,
                name: program.name,
                type: program.program_type,

                minimumAmount,
                minimumQuantity,

                missingAmount,
                missingQuantity,

                rewards: formatRewards(
                    programRewards
                ),

                status,

                disclaimer:
                    "Estimate only; Odoo must validate the coupon.",
                requiresCoupon,

                eligibilityVerified: false,
            };
        });

        return res.json({ offers });

    } catch (error) {
        console.error(
            "Offer preview failed:",
            error.message
        );

        return res.status(502).json({
            error: "Cannot evaluate offer preview"
        });
    }
});

// ==========================================
// 10. HEALTH CHECK
// ==========================================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "TM Sport Promotions API"
    });
});

// ==========================================
// 11. START SERVER
// ==========================================

app.listen(PORT, () => {
    console.log(
        `TM Sport API running on port ${PORT}`
    );
});

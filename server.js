
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
            "program_type",
            "once_per_user",
            "limit_usage",
            "max_usage",
            "total_order_count"
        ]
    );
}



function getProgramUsageStatus(program) {
    const hasGlobalLimit =
        program.limit_usage === true;

    const maxUsage = program.max_usage;
    const usedCount = program.total_order_count;

    const hasValidCounts =
        Number.isSafeInteger(maxUsage) &&
        Number.isSafeInteger(usedCount) &&
        maxUsage > 0 &&
        usedCount >= 0;

    const globalLimitReached =
        hasGlobalLimit &&
        hasValidCounts &&
        usedCount >= maxUsage;

    return {
        globalLimitReached,
        customerUsageVerified: false,
        oncePerUser: program.once_per_user === true
    };
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
                "minimum_amount_tax_mode",
                "product_ids",
                "product_category_id",
                "product_tag_id"
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
            const usage = getProgramUsageStatus(program);

            const requiresCoupon = [
                "promo_code",
                "coupons",
                "next_order_coupons"
            ].includes(program.program_type);

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

                status: "conditions_not_evaluated",
                usedUpVerified: usage.globalLimitReached,

                usageStatus: {
                    globalLimitReached: usage.globalLimitReached,
                    customerUsageVerified: usage.customerUsageVerified,
                    oncePerUser: usage.oncePerUser
                },
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


function validItems(items) {
    return Array.isArray(items) &&
        items.length <= 100 &&
        items.every(item =>
            Number.isSafeInteger(item.productId) &&
            item.productId > 0 &&
            Number.isFinite(item.quantity) &&
            item.quantity > 0 &&
            Number.isFinite(item.subtotalInclTax) &&
            item.subtotalInclTax >= 0 &&
            Number.isFinite(item.subtotalExclTax) &&
            item.subtotalExclTax >= 0
        );
}

async function getCartProducts(items) {
    const ids = [...new Set(
        items.map(item => item.productId)
    )];

    if (!ids.length) return [];

    return odooSearchRead(
        "product.product",
        [["id", "in", ids]],
        ["id", "categ_id"]
    );
}

async function getCategoryPaths(products) {
    const categoryIds = [
        ...new Set(
            products
                .map(p => relationId(p.categ_id))
                .filter(id => id !== null)
        )
    ];

    if (!categoryIds.length) return [];

    return odooSearchRead(
        "product.category",
        [["id", "in", categoryIds]],
        ["id", "parent_path"]
    );
}

function matchesCategory(
    productCategoryId,
    requiredCategoryId,
    categories
) {
    const category = categories.find(
        c => c.id === productCategoryId
    );

    if (!category) return false;

    const ancestors = String(category.parent_path || "")
        .split("/")
        .filter(Boolean)
        .map(Number);

    return ancestors.includes(requiredCategoryId);
}


// ==========================================
// 9. API KIEM TRA DIEU KIEN GIO HANG
// POST /api/offers/preview
// ==========================================


app.post("/api/offers/preview", async (req, res) => {
    try {
        const {
            cartAmount,
            cartQuantity,
            items
        } = req.body || {};

        if (
            !Number.isFinite(cartAmount) ||
            cartAmount < 0 ||
            !Number.isSafeInteger(cartQuantity) ||
            cartQuantity < 0 ||
            !validItems(items)
        ) {
            return res.status(400).json({
                error: "Invalid cart preview data"
            });
        }

        res.set("Cache-Control", "no-store");

        const {
            programs,
            rules,
            rewards
        } = await getPromotionData();

        // Lay danh muc thuc te tu Odoo
        const products = await getCartProducts(items);
        const categories = await getCategoryPaths(products);

        const productMap = new Map(
            products.map(product => [
                product.id,
                product
            ])
        );

        const offers = programs.map(program => {
            const usage = getProgramUsageStatus(program);
            const programRules = getRulesForProgram(
                rules,
                program.id
            );

            const programRewards = getRewardsForProgram(
                rewards,
                program.id
            );

            const requiresCoupon = [
                "promo_code",
                "coupons",
                "next_order_coupons"
            ].includes(program.program_type);

            // Chua tu dong danh gia chuong trinh
            // co nhieu rule hoac chua co rule
            if (programRules.length !== 1) {
                return {
                    id: program.id,
                    name: program.name,
                    type: program.program_type,
                    requiresCoupon,
                    rewards: formatRewards(programRewards),
                    status: "requires_additional_checks",
                    eligibilityVerified: false
                };
            }

            const rule = programRules[0];

            const requiredCategoryId =
                relationId(rule.product_category_id);

            const allowedProductIds =
                Array.isArray(rule.product_ids)
                    ? rule.product_ids
                    : [];

            const hasCategory = requiredCategoryId !== null;
            const hasProducts = allowedProductIds.length > 0;
            const hasTags = Boolean(rule.product_tag_id);

            const minimumAmount = Number(
                rule.minimum_amount || 0
            );

            const minimumQuantity = Number(
                rule.minimum_qty || 0
            );

            const taxMode = rule.minimum_amount_tax_mode;

            // Neu quy tac su dung tag hoac dong thoi
            // nhieu kieu loc, chua tu ket luan
            const unsupportedRule =
                hasTags || (hasCategory && hasProducts);

            let qualifiedAmount = 0;
            let qualifiedQuantity = 0;

            // Xem truoc theo tung dong san pham
            for (const item of items) {
                const product = productMap.get(item.productId);

                if (!product) continue;

                const productCategoryId =
                    relationId(product.categ_id);

                let matches = true;

                if (hasCategory) {
                    matches = matchesCategory(
                        productCategoryId,
                        requiredCategoryId,
                        categories
                    );
                } else if (hasProducts) {
                    matches = allowedProductIds.includes(
                        item.productId
                    );
                }

                if (!matches) continue;

                qualifiedQuantity += item.quantity;

                qualifiedAmount += taxMode === "excl"
                    ? item.subtotalExclTax
                    : item.subtotalInclTax;
            }

            const missingAmount = Math.max(
                0,
                minimumAmount - qualifiedAmount
            );

            const missingQuantity = Math.max(
                0,
                minimumQuantity - qualifiedQuantity
            );

            let status;

            if (unsupportedRule || !items.length) {
                status = "requires_additional_checks";
            } else if (
                missingAmount > 0 ||
                missingQuantity > 0
            ) {
                status = "minimum_not_met";
            } else {
                status = "minimum_met";
            }

            // Phieu cho don hang tiep theo:
            // dieu kien nay dung de nhan phieu,
            // khong phai xac nhan su dung ngay
            if (
                program.program_type === "next_order_coupons" &&
                status === "minimum_met"
            ) {
                status = "next_order_offer";
            }

            return {
                id: program.id,
                name: program.name,
                type: program.program_type,
                requiresCoupon,
                minimumAmount,
                minimumQuantity,
                qualifiedAmount,
                qualifiedQuantity,
                missingAmount,
                missingQuantity,
                requiredCategoryId,
                rewards: formatRewards(programRewards),
                status,
                eligibilityVerified: false,
                disclaimer:
                    "Preview only. Odoo validates coupon usage.",

                usedUpVerified: usage.globalLimitReached,

                usageStatus: {
                    globalLimitReached: usage.globalLimitReached,
                    customerUsageVerified: usage.customerUsageVerified,
                    oncePerUser: usage.oncePerUser
                },

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


require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("node:path");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

const app = express();

const {
    PORT = 3000,
    ODOO_URL,
    ODOO_API_KEY,
    ALLOWED_ORIGIN,
    AUTH_SECRET,
    SMTP_HOST,
    SMTP_PORT = "587",
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM
} = process.env;

// ==========================================
// 1. KIEM TRA CAU HINH
// ==========================================

if (!ODOO_URL || !ODOO_API_KEY || !ALLOWED_ORIGIN || !AUTH_SECRET || AUTH_SECRET.length < 32 || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
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
// 10. PORTAL EMAIL VERIFICATION
// A verified email is mapped to ONE portal partner.
// Never accept userId or partnerId from the browser.
// ==========================================
const authPending = new Map(); // Single Render instance; resets on restart.
const authCooldown = new Map();
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_LIFETIME_MS = 24 * 60 * 60 * 1000;
const mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
});

function normalizeEmail(raw) {
    const email = String(raw || "").trim().toLowerCase();
    return email.length <= 254 && MAIL_RE.test(email) ? email : null;
}
function digest(value) {
    return crypto.createHmac("sha256", AUTH_SECRET).update(String(value)).digest("hex");
}
function safeEqualHex(left, right) {
    return typeof left === "string" && typeof right === "string" &&
        left.length === right.length &&
        crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function signToken(partnerId) {
    const payload = Buffer.from(JSON.stringify({
        pid: partnerId,
        exp: Date.now() + ACCESS_LIFETIME_MS,
        nonce: crypto.randomBytes(12).toString("hex")
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", AUTH_SECRET)
        .update(payload).digest("base64url");
    return `${payload}.${signature}`;
}
function verifyToken(token) {
    if (typeof token !== "string" || token.length > 1024) return null;
    const [payload, signature, more] = token.split(".");
    if (!payload || !signature || more !== undefined) return null;
    const expected = crypto.createHmac("sha256", AUTH_SECRET)
        .update(payload).digest("base64url");
    if (signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
        const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Number.isSafeInteger(obj.pid) && obj.pid > 0 &&
            Number.isFinite(obj.exp) && obj.exp > Date.now() ? obj.pid : null;
    } catch { return null; }
}

// Only accept an unambiguous email belonging to a portal account.
async function portalPartnerForEmail(email) {
    const partners = await odooSearchRead("res.partner", [["email", "=ilike", email]],
        ["id", "email"]);
    const exact = partners.filter(p => normalizeEmail(p.email) === email);
    if (exact.length !== 1) return null;
    const users = await odooSearchRead("res.users", [
        ["partner_id", "=", exact[0].id], ["share", "=", true], ["active", "=", true]
    ], ["id", "partner_id", "share"]);
    return users.length === 1 ? exact[0].id : null;
}

const otpLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 5,
    standardHeaders: "draft-7", legacyHeaders: false
});
const verifyLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 12,
    standardHeaders: "draft-7", legacyHeaders: false
});

app.post("/api/auth/request-code", otpLimit, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Email không hợp lệ" });
    const key = digest(`mail:${email}`);
    const generic = { message: "Nếu email thuộc tài khoản Portal, mã xác minh sẽ được gửi." };
    if ((authCooldown.get(key) || 0) > Date.now()) return res.json(generic);
    authCooldown.set(key, Date.now() + 60 * 1000);
    try {
        const partnerId = await portalPartnerForEmail(email);
        if (!partnerId) return res.json(generic);
        const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        authPending.set(key, {
            codeHash: digest(`${key}:${otp}`), partnerId,
            expires: Date.now() + OTP_LIFETIME_MS, attempts: 0
        });
        await mailer.sendMail({
            from: SMTP_FROM, to: email,
            subject: "TM Sport - Mã xác minh ưu đãi",
            text: `Mã xác minh ưu đãi TM Sport: ${otp}. Hiệu lực 10 phút. Nếu không yêu cầu, hãy bỏ qua email này.`
        });
        return res.json(generic);
    } catch (err) {
        console.error("OTP dispatch failed:", err.message);
        return res.status(503).json({ error: "Chưa gửi được email, vui lòng thử lại sau." });
    }
});

app.post("/api/auth/verify-code", verifyLimit, (req, res) => {
    res.set("Cache-Control", "no-store");
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    if (!email || !/^\d{6}$/.test(code))
        return res.status(400).json({ error: "Thông tin xác minh không hợp lệ" });
    const key = digest(`mail:${email}`);
    const pending = authPending.get(key);
    if (!pending || pending.expires <= Date.now() || pending.attempts >= 5) {
        authPending.delete(key);
        return res.status(401).json({ error: "Mã đã hết hạn hoặc không hợp lệ" });
    }
    pending.attempts++;
    if (!safeEqualHex(digest(`${key}:${code}`), pending.codeHash)) {
        if (pending.attempts >= 5) authPending.delete(key);
        return res.status(401).json({ error: "Mã không hợp lệ" });
    }
    authPending.delete(key);
    return res.json({ token: signToken(pending.partnerId), expiresIn: 86400 });
});

app.get("/api/offers/customer-usage", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const bearer = /^Bearer (.+)$/i.exec(req.get("Authorization") || "");
    const partnerId = verifyToken(bearer?.[1]);
    if (!partnerId) return res.status(401).json({ error: "Yêu cầu xác minh lại email" });
    try {
        const programs = await odooSearchRead("loyalty.program", [
            ["id", "=", 2], ["active", "=", true], ["once_per_user", "=", true]
        ], ["id", "once_per_user", "partner_ids"]);
        return res.json({
            customerUsageVerified: true,
            usedProgramIds: programs.filter(p =>
                Array.isArray(p.partner_ids) && p.partner_ids.includes(partnerId)
            ).map(p => p.id)
        });
    } catch (error) {
        console.error("Customer usage failed:", error.message);
        return res.status(502).json({ error: "Không kiểm tra được lịch sử ưu đãi" });
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

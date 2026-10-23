
(() => {
    "use strict";

    const API_URL =
        "https://odoo-project-ayy3.onrender.com/api/offers/preview";

    const CART_URL = "/shop/cart";

    let refreshTimer = null;
    let refreshVersion = 0;
    let lastCartSignature = "";

    const money = value =>
        new Intl.NumberFormat("vi-VN", {
            style: "currency",
            currency: "VND",
            maximumFractionDigits: 0
        }).format(value);

    function addText(parent, tag, value, className = "") {
        const el = document.createElement(tag);
        el.textContent = value;

        if (className) {
            el.className = className;
        }

        parent.appendChild(el);
        return el;
    }


    function renderOffers(offers, container) {
        container.replaceChildren();

        if (!Array.isArray(offers) || !offers.length) {
            addText(
                container,
                "p",
                "Hiện chưa có ưu đãi công khai."
            );
            return;
        }

        const count = addText(
            container,
            "p",
            `${offers.length} chương trình ưu đãi`,
            "tms-offers-count"
        );

        for (const offer of offers) {
            const card = document.createElement("details");
            card.className = "tms-offer-card";

            const summary = document.createElement("summary");
            summary.className = "tms-offer-summary";

            const info = document.createElement("div");
            info.className = "tms-offer-info";

            addText(
                info,
                "strong",
                offer.name,
                "tms-offer-name"
            );

            const status = offer.status;

            let statusText = "Cần kiểm tra thêm";
            let statusClass = "tms-offer-warning";


            if (offer.appliedInCart) {
                statusText = "Đã áp dụng vào giỏ hàng";
                statusClass = "tms-offer-success";

            } else if (offer.usedUpVerified === true) {
                statusText = "Đã sử dụng";
                statusClass = "tms-offer-used";
                card.classList.add("tms-offer-card--used");
            } else if (status === "minimum_met") {
                statusText = offer.requiresCoupon
                    ? "Đạt mức mua · Cần mã"
                    : "Đạt mức mua";

                statusClass = "tms-offer-success";

            } else if (status === "minimum_not_met") {
                statusText = "Chưa đạt mức mua";

            } else if (status === "next_order_offer") {
                statusText = "Ưu đãi lần sau";
            }

            addText(
                info,
                "span",
                statusText,
                `tms-offer-status ${statusClass}`
            );

            const discount = (offer.rewards || []).find(
                reward =>
                    reward.type === "discount" &&
                    reward.mode === "percent"
            );

            if (discount) {
                addText(
                    info,
                    "p",
                    `Giảm ${discount.discount}%` +
                    (discount.maxDiscount
                        ? ` · Tối đa ${money(discount.maxDiscount)}`
                        : ""),
                    "tms-offer-desc"
                );
            }

            summary.appendChild(info);

            const arrow = document.createElement("span");
            arrow.className = "tms-offer-arrow";
            arrow.setAttribute("aria-hidden", "true");
            summary.appendChild(arrow);

            card.appendChild(summary);

            const details = document.createElement("div");
            details.className = "tms-offer-details";


            if (offer.appliedInCart) {
                addText(
                    details,
                    "p",
                    "Odoo đang ghi nhận phần thưởng của chương trình này trong giỏ hàng."
                );

            } else if (offer.usedUpVerified === true) {
                addText(
                    details,
                    "p",
                    "Mã giảm giá này đã hết lượt sử dụng."
                );

            } else if (status === "minimum_not_met") {
                if (offer.missingAmount > 0) {
                    addText(
                        details,
                        "p",
                        `Cần mua thêm ${money(offer.missingAmount)}`
                    );
                }

                if (offer.missingQuantity > 0) {
                    addText(
                        details,
                        "p",
                        `Cần thêm ${offer.missingQuantity} sản phẩm`
                    );
                }

            } else if (status === "next_order_offer") {
                addText(
                    details,
                    "p",
                    "Đơn hàng đủ điều kiện có thể giúp bạn nhận phiếu cho lần mua tiếp theo."
                );

            } else if (status === "minimum_met") {
                addText(
                    details,
                    "p",
                    offer.requiresCoupon
                        ? "Đã đạt điều kiện mua hàng sơ bộ. Bạn vẫn cần mã hoặc phiếu giảm giá hợp lệ."
                        : "Đã đạt điều kiện mua hàng sơ bộ."
                );

            } else {
                addText(
                    details,
                    "p",
                    "Cần kiểm tra thêm sản phẩm, danh mục hoặc quyền sử dụng coupon."
                );
            }

            if (Number.isFinite(offer.minimumAmount)) {
                addText(
                    details,
                    "p",
                    `Giá trị tối thiểu: ${money(offer.minimumAmount)}`,
                    "tms-offer-condition"
                );
            }

            addText(
                details,
                "small",
                "Kết quả tham khảo. Odoo xác nhận khi áp dụng mã."
            );

            card.appendChild(details);
            container.appendChild(card);
        }
    }


    function readCart(root) {
        const section = root.querySelector(
            "#shop_cart.tms-cart #tms-cart-offers"
        );

        const itemsContainer = root.querySelector(
            "#shop_cart.tms-cart #tms-cart-items"
        );

        if (!section || !itemsContainer) {
            throw new Error("Missing cart data elements");
        }

        const cartAmount = Number(
            section.dataset.cartAmount
        );

        const cartQuantity = Number(
            section.dataset.cartQuantity
        );

        const items = Array.from(
            itemsContainer.querySelectorAll(".tms-cart-item")
        ).map(el => ({
            productId: Number(el.dataset.productId),
            quantity: Number(el.dataset.quantity),
            subtotalInclTax: Number(
                el.dataset.subtotalInclTax
            ),
            subtotalExclTax: Number(
                el.dataset.subtotalExclTax
            )
        }));

        if (
            !Number.isFinite(cartAmount) ||
            cartAmount < 0 ||
            !Number.isSafeInteger(cartQuantity) ||
            cartQuantity < 0 ||
            items.some(item =>
                !Number.isSafeInteger(item.productId) ||
                !Number.isFinite(item.quantity) ||
                !Number.isFinite(item.subtotalInclTax) ||
                !Number.isFinite(item.subtotalExclTax)
            )
        ) {
            throw new Error("Invalid cart data");
        }


        const appliedProgramIds = Array.from(
            root.querySelectorAll(
                "#shop_cart.tms-cart " +
                "#tms-applied-offers .tms-applied-offer"
            )
        ).map(element =>
            Number(element.dataset.programId)
        ).filter(Number.isSafeInteger);



        return {
            cartAmount,
            cartQuantity,
            items,
            appliedProgramIds
        };

    }

    async function fetchCurrentCart() {
        const response = await fetch(CART_URL, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
                "Accept": "text/html"
            }
        });

        if (!response.ok) {
            throw new Error("Cannot reload cart data");
        }

        const html = await response.text();

        const doc = new DOMParser().parseFromString(
            html,
            "text/html"
        );

        return readCart(doc);
    }

    async function updateOffers(force = false) {
        const section = document.querySelector(
            "#shop_cart.tms-cart #tms-cart-offers"
        );

        if (!section) return;

        const container = section.querySelector(
            "#tms-offers-list"
        );

        if (!container) return;

        const version = ++refreshVersion;

        try {
            container.textContent = "Đang cập nhật ưu đãi...";

            // Lay gio hang moi nhat tu Odoo
            const cart = await fetchCurrentCart();

            if (version !== refreshVersion) return;

            const signature = JSON.stringify(cart);

            if (!force && signature === lastCartSignature) {
                // Van tai lai uu dai khi chua co ket qua
                // de tranh hien thong tin cu
            }

            const response = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(cart)
            });

            if (!response.ok) {
                throw new Error(
                    `Offers API error: ${response.status}`
                );
            }

            const data = await response.json();

            if (version !== refreshVersion) return;

            lastCartSignature = signature;


            const appliedIds = new Set(
                cart.appliedProgramIds || []
            );

            const offers = (
                Array.isArray(data.offers) ? data.offers : []
            ).map(offer => ({
                ...offer,
                appliedInCart: appliedIds.has(offer.id)
            }));

            renderOffers(offers, container);


        } catch (error) {
            if (version !== refreshVersion) return;

            container.textContent =
                "Chưa thể cập nhật ưu đãi. Vui lòng tải lại giỏ hàng.";

            console.error("TM Sport offers:", error.message);
        }
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);

        // Cho Odoo hoan tat cap nhat AJAX
        refreshTimer = setTimeout(() => {
            updateOffers();
        }, 1000);
    }

    function init() {
        const cart = document.querySelector(
            "#shop_cart.tms-cart"
        );

        if (!cart) return;

        const lines = cart.querySelector(
            ".tms-cart__lines"
        );

        updateOffers(true);

        if (!lines) return;

        // Theo doi thay doi san pham, khong theo doi
        // noi dung khu vuc uu dai de tranh lap vo han
        const observer = new MutationObserver(mutations => {
            const relevant = mutations.some(mutation => {
                const element = mutation.target.nodeType === 1
                    ? mutation.target
                    : mutation.target.parentElement;

                return element &&
                    !element.closest("#tms-cart-offers") &&
                    !element.closest("#tms-cart-items");
            });

            if (relevant) {
                scheduleRefresh();
            }
        });

        observer.observe(lines, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: false
        });

        // Khi nguoi dung thay doi so luong
        cart.addEventListener("change", event => {
            if (
                event.target.closest(
                    ".css_quantity, .o_cart_product"
                )
            ) {
                scheduleRefresh();
            }
        });

        // Khi nhan nut tang/giam/xoa
        cart.addEventListener("click", event => {
            const control = event.target.closest(
                ".css_quantity a, .css_quantity button, " +
                ".o_cart_product a, .o_cart_product button"
            );

            if (control) {
                scheduleRefresh();
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, {
            once: true
        });
    } else {
        init();
    }
})();

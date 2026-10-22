
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

        if (!offers.length) {
            addText(container, "p", "Chưa có ưu đãi công khai.");
            return;
        }

        for (const offer of offers) {
            const card = document.createElement("div");
            card.className = "tms-offer-card";

            addText(card, "strong", offer.name);

            if (offer.status === "next_order_offer") {
                addText(
                    card,
                    "p",
                    "Ưu đãi dành cho đơn hàng tiếp theo",
                    "tms-offer-warning"
                );

                addText(
                    card,
                    "p",
                    "Đơn hàng đạt điều kiện có thể giúp bạn nhận phiếu cho lần mua tiếp theo.",
                    "tms-offer-desc"
                );

            } else if (offer.status === "minimum_met") {
                addText(
                    card,
                    "p",
                    offer.requiresCoupon
                        ? "Đạt mức mua tối thiểu · Cần mã hợp lệ"
                        : "Đã đạt mức mua tối thiểu",
                    "tms-offer-success"
                );

            } else if (offer.status === "minimum_not_met") {
                const messages = [];

                if (offer.missingAmount > 0) {
                    messages.push(
                        `Mua thêm ${money(offer.missingAmount)}`
                    );
                }

                if (offer.missingQuantity > 0) {
                    messages.push(
                        `Thêm ${offer.missingQuantity} sản phẩm`
                    );
                }

                addText(
                    card,
                    "p",
                    messages.join(" · ") || "Chưa đạt điều kiện",
                    "tms-offer-warning"
                );

            } else {
                addText(
                    card,
                    "p",
                    "Cần kiểm tra thêm điều kiện sản phẩm hoặc coupon",
                    "tms-offer-warning"
                );
            }

            const discount = (offer.rewards || []).find(
                reward =>
                    reward.type === "discount" &&
                    reward.mode === "percent"
            );

            if (discount) {
                addText(
                    card,
                    "p",
                    `Ưu đãi ${discount.discount}%` +
                    (discount.maxDiscount
                        ? ` · Tối đa ${money(discount.maxDiscount)}`
                        : ""),
                    "tms-offer-desc"
                );
            }

            addText(
                card,
                "small",
                "Thông tin tham khảo; Odoo xác nhận khi áp dụng mã."
            );

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

        return {
            cartAmount,
            cartQuantity,
            items
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

            renderOffers(
                Array.isArray(data.offers) ? data.offers : [],
                container
            );

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


(() => {
    "use strict";

    const API_URL =
        "https://odoo-project-ayy3.onrender.com/api/offers/preview";

    const money = value =>
        new Intl.NumberFormat("vi-VN", {
            style: "currency",
            currency: "VND",
            maximumFractionDigits: 0
        }).format(value);

    function addText(parent, tag, value, className = "") {
        const element = document.createElement(tag);
        element.textContent = value;
        if (className) element.className = className;
        parent.appendChild(element);
        return element;
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

            const status = offer.status;

            if (status === "minimum_met") {
                addText(
                    card,
                    "p",
                    "Đã đạt mức mua tối thiểu",
                    "tms-offer-success"
                );
            } else if (status === "minimum_not_met") {
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
                    messages.join(" · "),
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

    async function loadOffers() {
        const section = document.querySelector(
            "#shop_cart.tms-cart #tms-cart-offers"
        );

        if (!section) return;

        const container = section.querySelector(
            "#tms-offers-list"
        );

        if (!container) return;

        const cartAmount = Number(section.dataset.cartAmount);
        const cartQuantity = Number(
            section.dataset.cartQuantity
        );

        if (
            !Number.isFinite(cartAmount) ||
            !Number.isSafeInteger(cartQuantity) ||
            cartAmount < 0 ||
            cartQuantity < 0
        ) {
            container.textContent =
                "Chưa đọc được thông tin giỏ hàng.";
            return;
        }

        container.textContent = "Đang tải ưu đãi...";

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    cartAmount,
                    cartQuantity
                })
            });

            if (!response.ok) {
                throw new Error("API request failed");
            }

            const data = await response.json();

            renderOffers(
                Array.isArray(data.offers) ? data.offers : [],
                container
            );
        } catch (error) {
            container.textContent =
                "Không thể tải ưu đãi. Vui lòng thử lại sau.";
            console.error("TM Sport offers:", error.message);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadOffers);
    } else {
        loadOffers();
    }
})();

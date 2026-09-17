const paymentForm = (gateway = "payU") => {
  return `<p class="eyebrow">Checkout details</p>
            <div class="vmp-fetch-form" style="margin-top:4px">
              <div class="form-group bmd-form-group">
                <label for="${gateway}firstname">First name</label>
                <input type="text" name="firstname" id="${gateway}firstname" class="form-control" placeholder="Alex…" required autocomplete="given-name">
              </div>
              <div class="form-group bmd-form-group">
                <label for="${gateway}mobile">Mobile number</label>
                <input type="tel" name="mobile" id="${gateway}mobile" class="form-control" placeholder="+91…" required autocomplete="tel" inputmode="tel">
              </div>
              <div class="form-group bmd-form-group">
                <label for="${gateway}email">Email</label>
                <input type="email" name="email" id="${gateway}email" class="form-control" placeholder="you@example.com…" required autocomplete="email" spellcheck="false">
              </div>
            </div>`;
};

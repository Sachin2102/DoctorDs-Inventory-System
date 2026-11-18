#!/usr/bin/env python3
# =============================================================================
#  Doctor D's BBQ  -  Inventory & Sales Management Console  (new UI build)
#  ISE 519 Final Project  |  Function 2 owner: Sachin Rai
#
#  PURE-PYTHON build: no numpy / pandas / psycopg2 / streamlit.
#  Stdlib http.server + pg8000 (pure-Python Postgres driver), so it runs on
#  locked-down machines that block compiled DLLs.
#
#  This server does two jobs:
#    1. Serves the new single-page design (index.html + app.js).
#    2. Exposes JSON endpoints backed by the tested views / insert patterns.
#  All sale money is computed by the database function fn_finalize_sale -- the
#  app never duplicates the math, so the console and the engine cannot diverge.
#
#  SETUP:  py -m pip install pg8000
#          put your Postgres password in local_settings.json  {"db_password": "..."}
#          (that file is git-ignored, so the password is never published)
#  RUN:    py app.py            then open  http://localhost:8000
# =============================================================================
import http.server, os, json, datetime, decimal, urllib.parse, urllib.request, webbrowser, threading
import csv, io, re
import pg8000.native as pg

HERE = os.path.dirname(os.path.abspath(__file__))

def _local_password():
    """Password from the DD_DB_PASSWORD env var, else from local_settings.json."""
    if os.environ.get("DD_DB_PASSWORD"):
        return os.environ["DD_DB_PASSWORD"]
    try:
        with open(os.path.join(HERE, "local_settings.json"), encoding="utf-8") as f:
            return json.load(f).get("db_password", "")
    except (FileNotFoundError, ValueError):
        return ""

# ---- 1. DATABASE CONNECTION  (<-- EDIT host/user if your DBeaver setup differs)
DB = {
    "host":     "localhost",
    "port":     5432,
    "dbname":   os.environ.get("DD_DB_NAME", "postgres"),
    "user":     "postgres",
    "password": _local_password(),
}
PORT = 8000
API_VERSION = 6      # bump when the page needs new data; the page refuses a stale server clearly


def connect():
    return pg.Connection(user=DB["user"], password=DB["password"],
                         host=DB["host"], port=DB["port"], database=DB["dbname"])

def q(sql, **p):
    """Run a SELECT -> (columns, rows)."""
    c = connect()
    try:
        rows = c.run(sql, **p)
        return [col["name"] for col in c.columns], rows
    finally:
        c.close()

def rowdicts(sql, **p):
    cols, rows = q(sql, **p)
    return [dict(zip(cols, r)) for r in rows]

def scalar(sql, **p):
    _, rows = q(sql, **p)
    return rows[0] if rows else None

def settings():
    """Business settings (business_setting table): home state, market channel, licensor ..."""
    return {k: v for k, v in q("SELECT setting_key, setting_value FROM business_setting")[1]}

def home_state():
    return settings().get("home_state", "")

def products_by_code():
    return {r["product_code"]: r for r in rowdicts(
        "SELECT product_id, product_code, product_name FROM product ORDER BY product_id")}

def pgmsg(e):
    """Pull the clean server message out of a pg8000 error (its args[0] is a dict)."""
    a = getattr(e, "args", None)
    if a and isinstance(a[0], dict) and "M" in a[0]:
        return a[0]["M"]
    return str(e).splitlines()[0]

# ---- 2. WRITE OPERATIONS  (same insert patterns as the reference build) ------
def _insert_sale(c, part):
    """Insert one sale header + its lines inside the caller's transaction.
    part = {channel, county, items:[(product_id, qty, unit_price)], ship_rev, ship_exp, fee, prefix}.
    The app writes only what the owner knows; fn_finalize_sale derives the rest
    (revenue, product cost, scholarship, sales tax and the Shopify fee)."""
    sid = c.run("INSERT INTO sale (sale_date,channel_id,customer_id,tax_code,invoice_ref,"
                "shipping_revenue,shipping_expense,shopify_fees) "
                "VALUES (CURRENT_DATE,:ch,"
                # app sales are recorded under the customer named in business_setting
                "COALESCE((SELECT c.customer_id FROM customer c JOIN business_setting b "
                "  ON b.setting_key='app_customer' AND c.customer_name=b.setting_value "
                "  ORDER BY c.customer_id LIMIT 1), (SELECT MIN(customer_id) FROM customer)),"
                ":tc,'APP',:sr,:se,:fe) RETURNING sale_id",
                ch=part["channel"], tc=part["county"], sr=part.get("ship_rev", 0),
                se=part.get("ship_exp", 0), fe=part.get("fee", 0))[0][0]
    ref = f"{part.get('prefix', 'APP')}-{sid}"
    c.run("UPDATE sale SET invoice_ref=:r WHERE sale_id=:s", r=ref, s=sid)
    for pid, qty, price in part["items"]:
        c.run("INSERT INTO sale_item (sale_id,product_id,quantity,unit_price) "
              "VALUES (:s,:p,:q,:u)", s=sid, p=pid, q=qty, u=price)   # oversell trigger fires here
    c.run("SELECT fn_finalize_sale(:s)", s=sid)                          # one source of truth for the money
    return sid, ref

def record_sales(parts, label="Sale"):
    """Record one or more sales all-or-nothing (a market day = cash + card).
    -> (ok, message, data)."""
    c = connect()
    try:
        c.run("BEGIN")
        done = [_insert_sale(c, p) for p in parts]
        c.run("COMMIT")
        rows = c.run("SELECT COALESCE(SUM(item_charge),0), COALESCE(SUM(shipping_revenue),0), "
                      "COALESCE(SUM(state_tax),0), COALESCE(SUM(shopify_fees),0), "
                      "COALESCE(SUM(scholarship),0), COALESCE(SUM(gross_profit),0) "
                      "FROM sale WHERE sale_id = ANY(CAST(:ids AS INT[]))",
                      ids=[sid for sid, _ in done])[0]
        rev, ship, tax, fees, sch, prof = (float(x) for x in rows)
        refs = " + ".join(ref for _, ref in done)
        fee_txt = f", card fees ${fees:,.2f}" if fees else ""
        if len(done) == 1 and fees:                     # automatic fee: show how it was worked out
            name, pct, fixed = c.run("SELECT sc.channel_name, sc.fee_pct, sc.fee_fixed FROM sale s "
                                     "JOIN sales_channel sc ON sc.channel_id=s.channel_id WHERE s.sale_id=:s",
                                     s=done[0][0])[0]
            if pct > 0 or fixed > 0:
                base = rev + ship + tax
                fee_txt = (f", {name} fee ${fees:,.2f} (calculated automatically: {float(pct) * 100:g}% × ${base:,.2f}"
                           + (f" + ${float(fixed):,.2f}" if fixed else "") + ")")
        msg = (f"{label} {refs} recorded — revenue ${rev:,.2f}"
               + (f", shipping charged ${ship:,.2f}" if ship else "")
               + f", sales tax ${tax:,.2f}"
               + fee_txt
               + f", scholarship ${sch:,.2f}, gross profit ${prof:,.2f}.")
        return True, msg, {"revenue": rev, "tax": tax, "fees": fees, "scholarship": sch, "profit": prof}
    except Exception as e:
        try: c.run("ROLLBACK")
        except Exception: pass
        m = pgmsg(e)
        if "Oversell" in m:
            return False, "Blocked by the inventory guard — nothing was saved. " + m, None
        return False, "Couldn't record the sale — nothing was saved. " + m, None
    finally:
        c.close()

def split_by_share(total, counts):
    """Split a lump-sum amount between products by jar count (any number of products).
    Every product but the first is rounded to the cent and the first takes the
    remainder, so the parts always add up to exactly the money collected."""
    n = sum(counts)
    parts = [round(total * c / n, 2) if n else 0.0 for c in counts]
    if counts:
        parts[0] = round(total - sum(parts[1:]), 2)
    return parts

def add_batch(product_id, jars, code):
    c = connect()
    try:
        base = (code or "B").strip()
        for i in range(0, 100):
            attempt = base if i == 0 else f"{base}-{i}"
            try:
                c.run("INSERT INTO production_batch (product_id,batch_code,produced_date,jars_produced,unit_cost) "
                      "VALUES (:p,:code,CURRENT_DATE,:j,(SELECT unit_cost FROM product WHERE product_id=:p))",
                      p=product_id, code=attempt, j=jars)        # cost per jar comes from the product
            except Exception as e:
                d = getattr(e, "args", [{}])[0]
                if isinstance(d, dict) and d.get("C") == "23505":   # unique_violation -> next code
                    continue
                return False, pgmsg(e), None
            oh = int(c.run("SELECT on_hand FROM v_inventory_on_hand WHERE product_id=:p", p=product_id)[0][0])
            return True, f"Added {jars:,} jars (batch {attempt}). On hand now {oh:,} jars.", {"on_hand": oh, "batch": attempt}
        return False, "Could not generate a unique batch code — try a different code.", None
    finally:
        c.close()

def record_adjustment(product_id, quantity, reason, note):
    c = connect()
    try:
        c.run("INSERT INTO inventory_adjustment (product_id,adj_date,quantity,reason,note) "
              "VALUES (:p,CURRENT_DATE,:q,:r,:n)", p=product_id, q=quantity, r=reason, n=note)
        oh = int(c.run("SELECT on_hand FROM v_inventory_on_hand WHERE product_id=:p", p=product_id)[0][0])
        return True, f"Adjustment recorded ({reason}, {quantity:+d} jars). On hand now {oh:,} jars.", {"on_hand": oh}
    except Exception as e:
        return False, pgmsg(e), None
    finally:
        c.close()

def record_count(product_id, counted, note, reconcile):
    c = connect()
    try:
        sys_oh = int(c.run("SELECT on_hand FROM v_inventory_on_hand WHERE product_id=:p", p=product_id)[0][0])
        c.run("INSERT INTO inventory_count (product_id,count_date,counted_jars,note) "
              "VALUES (:p,CURRENT_DATE,:c,:n)", p=product_id, c=counted, n=note)
        variance = counted - sys_oh
        msg = f"Count saved — system said {sys_oh:,}, you counted {counted:,} (variance {variance:+d})."
        new_oh = sys_oh
        if reconcile and variance != 0:
            c.run("INSERT INTO inventory_adjustment (product_id,adj_date,quantity,reason,note) "
                  "VALUES (:p,CURRENT_DATE,:q,'Count Correction','Reconciled to physical count')",
                  p=product_id, q=variance)
            new_oh = int(c.run("SELECT on_hand FROM v_inventory_on_hand WHERE product_id=:p", p=product_id)[0][0])
            msg += f" System updated to {new_oh:,}."
        return True, msg, {"system": sys_oh, "counted": counted, "variance": variance, "on_hand": new_oh}
    except Exception as e:
        return False, pgmsg(e), None
    finally:
        c.close()

# ---- 2b. SETTINGS  (the Settings tab: products, channels, business settings) --
# Every rule the app follows lives in these tables, so editing them here changes the
# system with no code edits. Changes apply to NEW entries only: each saved sale keeps
# the revenue, cost, tax, fee and scholarship it was recorded with.
PRODUCT_CODE = re.compile(r"^[A-Z]{1,4}$")          # batch codes are <CODE>-B<number>
URL_KEYS = {"rate_file_url", "official_rates_url", "tax_guidance_url"}

def _field(data, key, label, lo, hi, integer=False, places=2):
    """A number from the request, checked against [lo, hi]."""
    raw = data.get(key)
    if raw is None or str(raw).strip() == "":
        raise RuntimeError(f"{label} is required.")
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise RuntimeError(f"{label} must be a number.")
    if integer:
        if v != int(v):
            raise RuntimeError(f"{label} must be a whole number.")
        v = int(v)
    else:
        v = round(v, places)
    if v < lo or v > hi:
        raise RuntimeError(f"{label} must be between {lo:g} and {hi:g}.")
    return v

def _text(data, key, label, maxlen):
    v = str(data.get(key) or "").strip()
    if not v:
        raise RuntimeError(f"{label} can't be blank.")
    if len(v) > maxlen:
        raise RuntimeError(f"{label} can be at most {maxlen} characters.")
    return v

def _transaction(work):
    """Run work(c) all-or-nothing; database refusals come back as plain messages."""
    c = connect()
    try:
        c.run("BEGIN")
        msg = work(c)
        c.run("COMMIT")
        return True, msg
    except Exception as e:
        try: c.run("ROLLBACK")
        except Exception: pass
        if isinstance(e, RuntimeError):
            return False, str(e)
        d = getattr(e, "args", [{}])[0]
        if isinstance(d, dict) and d.get("C") == "23505":
            return False, "That name or code is already used — pick another one. Nothing was saved."
        return False, "Nothing was saved. " + pgmsg(e)
    finally:
        c.close()

def save_product(data):
    """Edit a product, or add one (data['new'] = True). Prices, cost, reorder level,
    scholarship, food-tax flag and planning days all come from here."""
    is_new = bool(data.get("new"))
    code = str(data.get("code") or "").strip().upper()
    if not PRODUCT_CODE.match(code):
        raise RuntimeError("Product code must be 1–4 letters (A–Z), e.g. HB.")
    v = {
        "name": _text(data, "name", "Product name", 50),
        "retail": _field(data, "retail_price", "Retail price", 0, 9999.99),
        "wholesale": _field(data, "wholesale_price", "Wholesale price", 0, 9999.99),
        "cost": _field(data, "unit_cost", "Cost per jar", 0, 9999.99),
        "reorder": _field(data, "reorder_level", "Reorder level", 0, 1_000_000, integer=True),
        "cob": bool(data.get("is_cobranded")),
        "rate": round(_field(data, "scholarship_pct", "Scholarship %", 0, 100, places=1) / 100, 3),
        "food": bool(data.get("is_qualifying_food")),
        "lead": _field(data, "lead_time_days", "Lead time (days)", 1, 365, integer=True),
        "safety": _field(data, "safety_days", "Safety days", 0, 365, integer=True),
    }
    if not v["cob"] and v["rate"] > 0:
        raise RuntimeError(f"{v['name']}: only co-branded products pay a scholarship. "
                           "Tick Co-branded, or set the scholarship to 0%.")
    cols = ("product_name=:name, retail_price=:retail, wholesale_price=:wholesale, unit_cost=:cost, "
            "reorder_level=:reorder, is_cobranded=:cob, scholarship_rate=:rate, is_qualifying_food=:food, "
            "lead_time_days=:lead, safety_days=:safety")

    def work(c):
        if is_new:
            if c.run("SELECT 1 FROM product WHERE product_code=:k", k=code):
                raise RuntimeError(f"Product code {code} is already used — pick another one.")
            c.run("INSERT INTO product (product_code, product_name, retail_price, wholesale_price, unit_cost, "
                  "reorder_level, is_cobranded, scholarship_rate, is_qualifying_food, lead_time_days, safety_days) "
                  "VALUES (:k,:name,:retail,:wholesale,:cost,:reorder,:cob,:rate,:food,:lead,:safety)", k=code, **v)
            return (f"Added {v['name']} ({code}). It now appears in sales, market days, inventory, "
                    f"charts, reports and downloads. Add a production batch to give it stock.")
        c.run(f"UPDATE product SET {cols} WHERE product_code=:k", k=code, **v)
        if not c.row_count:
            raise RuntimeError(f"Product {code} doesn't exist any more — refresh the page.")
        return f"{v['name']} saved. New sales and batches use these values; past sales are unchanged."
    return _transaction(work)

def save_channel(data):
    """Edit a sales channel, or add one (no id). Renaming the market channel keeps
    the business_setting that points to it in step."""
    cid = data.get("id")
    v = {
        "name": _text(data, "name", "Channel name", 20),
        "taxable": bool(data.get("is_taxable")),
        "basis": str(data.get("price_basis") or ""),
        "ships": bool(data.get("ships_orders")),
        "pct": round(_field(data, "fee_pct", "Card fee %", 0, 99.99) / 100, 4),
        "fixed": _field(data, "fee_fixed", "Fixed fee per order", 0, 9999.99),
    }
    if v["basis"] not in ("retail", "wholesale", "free"):
        raise RuntimeError("Default price must be retail, wholesale or free.")

    def work(c):
        market = (c.run("SELECT setting_value FROM business_setting WHERE setting_key='market_channel'") or [[""]])[0][0]
        if cid in (None, ""):
            c.run("INSERT INTO sales_channel (channel_name, is_taxable, price_basis, ships_orders, fee_pct, fee_fixed) "
                  "VALUES (:name,:taxable,:basis,:ships,:pct,:fixed)", **v)
            return f"Added the {v['name']} channel. It's now on the sale form."
        old = c.run("SELECT channel_name FROM sales_channel WHERE channel_id=:i", i=int(cid))
        if not old:
            raise RuntimeError("That channel doesn't exist any more — refresh the page.")
        old = old[0][0]
        if old == market and (v["pct"] > 0 or v["fixed"] > 0):
            raise RuntimeError(f"{old} is the market channel: its card fee is the actual card-reader payout typed "
                               "on the market form, so its fee schedule must stay at 0. Nothing was saved.")
        c.run("UPDATE sales_channel SET channel_name=:name, is_taxable=:taxable, price_basis=:basis, "
              "ships_orders=:ships, fee_pct=:pct, fee_fixed=:fixed WHERE channel_id=:i", i=int(cid), **v)
        if old == market and v["name"] != old:
            c.run("UPDATE business_setting SET setting_value=:n WHERE setting_key='market_channel'", n=v["name"])
        return f"{v['name']} saved. New sales on this channel use these values; past sales are unchanged."
    return _transaction(work)

def save_business(data):
    """Save the business_setting rows plus the home state's qualifying-food tax rate.
    Every value is checked against the data it points to (state, county, channel)."""
    vals = {k: str(v if v is not None else "").strip() for k, v in (data.get("values") or {}).items()}
    food = round(_field(data, "food_rate_pct", "Qualifying-food tax rate", 0, 20) / 100, 4)

    def work(c):
        have = {k: v for k, v in c.run("SELECT setting_key, setting_value FROM business_setting")}
        unknown = sorted(set(vals) - set(have))
        if unknown:
            raise RuntimeError("Unknown setting: " + ", ".join(unknown))
        new = {**have, **vals}
        for k, v in new.items():
            if not v:
                raise RuntimeError(f"'{k.replace('_', ' ')}' can't be blank.")
            if len(v) > 300:
                raise RuntimeError(f"'{k.replace('_', ' ')}' can be at most 300 characters.")
            if k in URL_KEYS and not v.startswith("https://"):
                raise RuntimeError(f"'{k.replace('_', ' ')}' must be a web address starting with https://")
        home = new["home_state"].upper()
        new["home_state"] = home
        if not c.run("SELECT 1 FROM tax_code WHERE state=:s AND status<>'State only' LIMIT 1", s=home):
            raise RuntimeError(f"No counties are loaded for state '{home}', so it can't be the home state.")
        if not c.run("SELECT 1 FROM tax_code WHERE tax_code=:t AND state=:s", t=new["default_county"], s=home):
            raise RuntimeError(f"The default county must be one of the {home} counties.")
        if not c.run("SELECT 1 FROM sales_channel WHERE channel_name=:n", n=new["market_channel"]):
            raise RuntimeError(f"There is no sales channel called '{new['market_channel']}'.")
        mkt_fee = c.run("SELECT fee_pct > 0 OR fee_fixed > 0 FROM sales_channel WHERE channel_name=:n",
                        n=new["market_channel"])[0][0]
        if mkt_fee:
            raise RuntimeError(f"'{new['market_channel']}' has an automatic card-fee schedule, so it can't be the "
                               "market channel (the market form takes the card reader's actual fee).")
        try:
            window = int(new["demand_window_days"])
        except ValueError:
            raise RuntimeError("Demand window must be a whole number of days.")
        if not 7 <= window <= 3650:
            raise RuntimeError("Demand window must be between 7 and 3650 days.")
        new["demand_window_days"] = str(window)
        if len(new["app_customer"]) > 60:
            raise RuntimeError("The app customer name can be at most 60 characters.")

        # the customer that app sales are recorded under: renaming keeps its history
        if new["app_customer"] != have.get("app_customer"):
            if not c.run("SELECT 1 FROM customer WHERE customer_name=:n", n=new["app_customer"]):
                c.run("UPDATE customer SET customer_name=:n WHERE customer_name=:o",
                      n=new["app_customer"], o=have.get("app_customer", ""))
                if not c.row_count:                                    # old one gone: create it
                    c.run("INSERT INTO customer (customer_name, customer_type) VALUES (:n, 'Retail')",
                          n=new["app_customer"])

        changed = [k for k in new if new[k] != have.get(k)]
        for k in changed:
            c.run("UPDATE business_setting SET setting_value=:v WHERE setting_key=:k", v=new[k], k=k)

        # qualifying-food rate: collected only in the home state (tax_code.food_rate)
        old_home = have.get("home_state", "")
        if home != old_home:
            c.run("UPDATE tax_code SET food_rate=NULL WHERE state=:s", s=old_home)
        c.run("UPDATE tax_code SET food_rate=:r WHERE state=:s", r=food, s=home)

        parts = [f"{len(changed)} setting{'s' if len(changed) != 1 else ''} changed",
                 f"{home} qualifying-food rate {food * 100:g}%"]
        if home != old_home:
            parts.append(f"sales tax is now collected in {home} instead of {old_home} — "
                         f"check its general rates on the Tax rates tab")
        return "Business settings saved: " + "; ".join(parts) + ". Past sales are unchanged."
    return _transaction(work)

# ---- 3. READ / BOOTSTRAP  (everything the UI displays, from the views) ------
def bootstrap():
    ensure_schema()
    cfg = settings()
    home = cfg.get("home_state", "")
    products = [{"id": r["product_id"], "code": r["product_code"], "name": r["product_name"],
                 "is_cobranded": bool(r["is_cobranded"]), "scholarship_rate": float(r["scholarship_rate"]),
                 "retail_price": float(r["retail_price"]), "wholesale_price": float(r["wholesale_price"]),
                 "unit_cost": float(r["unit_cost"]), "reorder_level": int(r["reorder_level"]),
                 "lead_time_days": int(r["lead_time_days"]), "safety_days": int(r["safety_days"]),
                 "is_qualifying_food": bool(r["is_qualifying_food"])}
                for r in rowdicts("SELECT product_id,product_code,product_name,is_cobranded,scholarship_rate,"
                                  "retail_price,wholesale_price,unit_cost,reorder_level,lead_time_days,"
                                  "safety_days,is_qualifying_food FROM product ORDER BY product_id")]

    channels = []
    for r in rowdicts("SELECT channel_id,channel_name,is_taxable,fee_pct,fee_fixed,price_basis,ships_orders "
                      "FROM sales_channel ORDER BY channel_id"):
        channels.append({"id": r["channel_id"], "name": r["channel_name"],
                         "taxable": bool(r["is_taxable"]), "price_basis": r["price_basis"],
                         "ships": bool(r["ships_orders"]),
                         "fee_pct": float(r["fee_pct"]), "fee_fixed": float(r["fee_fixed"])})

    # every county from Function 1 (all states), NC first: the sale form lets the
    # owner pick the customer's state, so out-of-state online orders can be logged
    counties = [{"code": r["tax_code"], "state": r["state"], "county": r["county"],
                 "status": r["status"],
                 "rate": float(r["tax_rate"]) if r["tax_rate"] is not None else None,
                 "food_rate": float(r["food_rate"]) if r["food_rate"] is not None else None}
                for r in rowdicts("SELECT tax_code,state,county,tax_rate,food_rate,status FROM tax_code "
                                  "ORDER BY (state<>:h), state, county", h=home)]

    inventory = [{"code": r["product_code"], "name": r["product_name"],
                  "produced": int(r["total_produced"]), "adjusted": int(r["total_adjusted"]),
                  "sold": int(r["total_sold"]), "on_hand": int(r["on_hand"]),
                  "reorder": int(r["reorder_level"]), "status": r["stock_status"]}
                 for r in rowdicts("SELECT product_code,product_name,total_produced,total_adjusted,"
                                   "total_sold,on_hand,reorder_level,stock_status "
                                   "FROM v_inventory_on_hand ORDER BY product_id")]

    rev, sch, prof = scalar("SELECT COALESCE(SUM(item_charge),0),COALESCE(SUM(scholarship),0),"
                            "COALESCE(SUM(gross_profit),0) FROM sale")
    n_sales, n_channels = scalar("SELECT (SELECT COUNT(*) FROM sale), (SELECT COUNT(*) FROM sales_channel)")
    totals = {"revenue": float(rev), "scholarship": float(sch), "gross_profit": float(prof),
              "sales": int(n_sales), "channels": int(n_channels)}

    by_product, by_rev = {}, {}                         # month -> {product code: jars / revenue}
    for r in rowdicts("SELECT month, product_code, jars, revenue FROM v_monthly_product"):
        by_product.setdefault(r["month"], {})[r["product_code"]] = int(r["jars"])
        by_rev.setdefault(r["month"], {})[r["product_code"]] = float(r["revenue"])
    monthly = [{"month": r["month"], "jars": int(r["jars_sold"]), "by": by_product.get(r["month"], {}),
                "by_rev": by_rev.get(r["month"], {}),
                "revenue": float(r["revenue"]), "expenses": float(r["expenses"]),
                "scholarship": float(r["scholarship_owed"]), "gross_profit": float(r["gross_profit"])}
               for r in rowdicts("SELECT month,jars_sold,revenue,expenses,scholarship_owed,"
                                 "gross_profit FROM v_monthly_report")]

    channels_sales = [{"name": r["channel_name"], "units": int(r["units_sold"]),
                       "revenue": float(r["revenue"])}
                      for r in rowdicts("SELECT channel_name,units_sold,revenue FROM v_sales_by_channel")]

    reorder = [{"code": r["product_code"], "name": r["product_name"],
                "avg_daily": float(r["avg_daily_demand"]), "lead": int(r["lead_time_days"]),
                "safety": int(r["safety_days"]), "suggested": int(r["suggested_reorder"]),
                "current": int(r["current_reorder"]), "window": int(r["demand_window_days"])}
               for r in rowdicts("SELECT product_code,product_name,avg_daily_demand,lead_time_days,"
                                 "safety_days,suggested_reorder,current_reorder,demand_window_days "
                                 "FROM v_reorder_suggestion")]

    count_variance = [{"code": r["product_code"], "name": r["product_name"],
                       "system_on_hand": int(r["system_on_hand"]),
                       "counted": int(r["counted_jars"]) if r["counted_jars"] is not None else None,
                       "count_date": r["count_date"].strftime("%b %d, %Y") if r["count_date"] else None,
                       "variance": int(r["variance"]) if r["variance"] is not None else None}
                      for r in rowdicts("SELECT product_code,product_name,system_on_hand,counted_jars,"
                                        "count_date,variance FROM v_count_variance")]

    ledger = [{"date": r[0], "code": r[1], "type": r[2], "qty": int(r[3]),
               "ref": r[4] or "", "today": bool(r[5])}
              for r in q("SELECT TO_CHAR(movement_date,'Mon DD, YYYY'), product_code, movement_type, "
                         "quantity_change, COALESCE(reference,''), (movement_date=CURRENT_DATE) "
                         "FROM v_inventory_ledger ORDER BY movement_date DESC, movement_type LIMIT 60")[1]]

    recent_sales = [{"id": r[0], "date": r[1], "channel": r[2], "county": r[3] or "—", "state": r[4] or "",
                     "rev": float(r[5]), "ship": float(r[6]), "tax": float(r[7]), "fees": float(r[8]),
                     "ship_exp": float(r[9]), "sch": float(r[10]), "profit": float(r[11]), "ref": r[12] or "",
                     "jars": {}}
                    for r in q(
        "SELECT s.sale_id, TO_CHAR(s.sale_date,'Mon DD, YYYY'), sc.channel_name, t.county, t.state, "
        "s.item_charge, s.shipping_revenue, s.state_tax, s.shopify_fees, s.shipping_expense, "
        "s.scholarship, s.gross_profit, s.invoice_ref "
        "FROM sale s JOIN sales_channel sc ON sc.channel_id=s.channel_id "
        "LEFT JOIN tax_code t ON t.tax_code=s.tax_code "
        "ORDER BY s.sale_date DESC, s.sale_id DESC LIMIT 25")[1]]
    if recent_sales:                                   # jars per product on those sales (any products)
        by_id = {r["id"]: r for r in recent_sales}
        for sid, code, n in q("SELECT si.sale_id, p.product_code, SUM(si.quantity) FROM sale_item si "
                              "JOIN product p ON p.product_id=si.product_id "
                              "WHERE si.sale_id = ANY(CAST(:ids AS INT[])) GROUP BY 1, 2",
                              ids=list(by_id))[1]:
            by_id[sid]["jars"][code] = int(n)

    # Function 3: monthly NC State licensing report (co-branded SS only)
    scholarship_monthly = [{"month": r["month"], "co_jars": int(r["cobranded_jars"]),
                            "co_revenue": float(r["cobranded_revenue"]),
                            "owed": float(r["scholarship_owed"]),
                            "ex_jars": int(r["excluded_jars"]), "ex_revenue": float(r["excluded_revenue"])}
                           for r in rowdicts("SELECT month,cobranded_jars,cobranded_revenue,scholarship_owed,"
                                             "excluded_jars,excluded_revenue FROM v_scholarship_owed")]

    # Function 1's own rows only ("County not listed" state-only rows are excluded)
    cl, states, rev_req = scalar("SELECT COUNT(*), COUNT(DISTINCT state), "
                                 "COUNT(*) FILTER (WHERE status='Review Required') FROM tax_code "
                                 "WHERE status <> 'State only'")
    home_status, home_last = {}, None
    for st_name, n, lr in q("SELECT status, COUNT(*), MAX(last_refreshed) FROM tax_code "
                            "WHERE state=:h GROUP BY status", h=home)[1]:
        home_status[st_name] = int(n)
        if lr and (home_last is None or lr > home_last):
            home_last = lr
    tax_summary = {"counties_loaded": int(cl), "states_covered": int(states),
                   "review_required": int(rev_req), "home_status": home_status,
                   "home_last_refreshed": home_last.strftime("%b %d, %Y") if home_last else None}
    tax_states = [r[0] for r in q("SELECT DISTINCT state FROM tax_code ORDER BY state")[1]]
    tax_review = [{"state": r[0], "county": r[1], "status": r[2]}
                  for r in q("SELECT state,county,status FROM tax_code WHERE status='Review Required' "
                             "ORDER BY state,county LIMIT 300")[1]]

    # taxable base = items + shipping charged (NC taxes delivery charges too)
    tax_by_county = [{"county": r[0], "rate": float(r[1]) if r[1] is not None else None,
                      "base": float(r[2]), "tax": float(r[3])}
                     for r in q(
        "SELECT t.county, t.food_rate, ROUND(SUM(s.item_charge+s.shipping_revenue),2), "
        "ROUND(SUM(s.state_tax),2) "
        "FROM sale s JOIN sales_channel sc ON sc.channel_id=s.channel_id "
        "JOIN tax_code t ON t.tax_code=s.tax_code "
        "WHERE sc.is_taxable AND t.state=:h "
        "GROUP BY t.county, t.food_rate HAVING SUM(s.state_tax)>0 "
        "ORDER BY SUM(s.state_tax) DESC LIMIT 25", h=home)[1]]
    out_of_state = scalar("SELECT COUNT(*), COALESCE(SUM(s.item_charge+s.shipping_revenue),0) "
                          "FROM sale s JOIN tax_code t ON t.tax_code=s.tax_code WHERE t.state<>:h", h=home)

    today_date = scalar("SELECT TO_CHAR(CURRENT_DATE,'Mon DD, YYYY')")[0]
    # next free batch number per product, e.g. SS-B052 (codes look like <CODE>-B<number>[-n])
    next_batch = {r[0]: f"{r[0]}-B{int(r[1]) + 1:03d}" for r in q(
        "SELECT p.product_code, COALESCE(MAX(CAST(substring(b.batch_code FROM '^[A-Z]+-B([0-9]+)') AS INT)), 0) "
        "FROM product p LEFT JOIN production_batch b ON b.product_id = p.product_id GROUP BY p.product_code")[1]}
    first_sale, last_sale = scalar("SELECT MIN(sale_date), MAX(sale_date) FROM sale")   # chart flags partial months

    setting_rows = [{"key": r[0], "value": r[1], "description": r[2]} for r in q(
        "SELECT setting_key, setting_value, description FROM business_setting ORDER BY setting_key")[1]]

    return {"api_version": API_VERSION, "settings": cfg, "setting_rows": setting_rows, "today_date": today_date, "data_from": first_sale.isoformat() if first_sale else None,
            "data_through": last_sale.isoformat() if last_sale else None,
            "products": products, "channels": channels, "counties": counties,
            "inventory": inventory, "totals": totals, "monthly": monthly,
            "channels_sales": channels_sales, "reorder": reorder,
            "count_variance": count_variance, "ledger": ledger, "recent_sales": recent_sales,
            "tax_summary": tax_summary, "tax_states": tax_states, "tax_review": tax_review,
            "tax_by_county": tax_by_county, "scholarship_monthly": scholarship_monthly, "next_batch": next_batch,
            "out_of_state": {"orders": int(out_of_state[0]), "sales": float(out_of_state[1])}}

def tax_counties(state):
    return [{"code": r["tax_code"], "county": r["county"],
             "rate": float(r["tax_rate"]) if r["tax_rate"] is not None else None,
             "lookup_rate": float(r["lookup_rate"]) if r["lookup_rate"] is not None else None,
             "food_rate": float(r["food_rate"]) if r["food_rate"] is not None else None,
             "status": r["status"],
             "effective": r["effective_date"].strftime("%b %d, %Y") if r["effective_date"] else None,
             "source": r["rate_source"] or ""}
            for r in rowdicts("SELECT tax_code,county,tax_rate,lookup_rate,food_rate,status,effective_date,"
                              "rate_source FROM tax_code WHERE state=:s ORDER BY county", s=state)]

# ---- 3b. TAX RATES: keep NC rates current -----------------------------------
# Function 1 (County_Tax_Lookup.csv) adds only the state + county rate. Some NC
# counties also charge a local transit / special-district tax, so their real
# rate is higher. "Check for updates" downloads the latest rate file (a public
# mirror of the official Streamlined Sales Tax / NCDOR rate files), adds those
# local taxes in, layers the hand-checked tax_rates.csv on top, and shows every
# change BEFORE anything is saved. Pure Python: urllib + csv, no pandas.
def rate_file_url():                         # business_setting: where the rate files are downloaded from
    return settings().get("rate_file_url", "")
TAX_FOLDER   = os.path.normpath(os.environ.get("DD_TAX_FOLDER", os.path.join(HERE, "..", "tax_rates")))
TAX_CACHE    = os.path.join(HERE, "tax_cache")
FUNCTION1_SOURCE = "Function 1 - County_Tax_Lookup.csv"

_schema_ok = False

REQUIRED_COLUMNS = {   # columns this version of the app needs (from the current SQL script)
    "tax_code": {"fips_code", "status", "food_rate", "lookup_rate", "effective_date",
                 "rate_source", "last_refreshed"},
    "sales_channel": {"fee_pct", "fee_fixed", "price_basis", "ships_orders"},
    "product": {"is_qualifying_food", "lead_time_days", "safety_days"},
    "business_setting": {"setting_key", "setting_value"},
}

def ensure_schema():
    """Stop with one clear instruction if the database was loaded from an older
    version of DoctorDs_Inventory_System.sql."""
    global _schema_ok
    if _schema_ok:
        return
    have = {}
    for t, col in q("SELECT table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema='public'")[1]:
        have.setdefault(t, set()).add(col)
    missing = [f"{t}.{c}" for t, cols in REQUIRED_COLUMNS.items() for c in sorted(cols - have.get(t, set()))]
    if missing:
        old = "fips_code" in " ".join(missing)
        raise RuntimeError(
            ("Your database is still on the old 10-county script, so the Function 1 tax data isn't there. "
             if old else
             "Your database was loaded from an older version of the script (it's missing "
             + ", ".join(missing[:4]) + ("…" if len(missing) > 4 else "") + "). ")
            + "In DBeaver, open DoctorDs_Inventory_System.sql, pick the postgres connection, "
              "run the whole script with Alt+X, then refresh this page.")
    _schema_ok = True

def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()

def fetch_rate_files(live=True):
    """-> (state_csv, jurisdiction_csv, how, when, problem).
    live=True downloads a fresh copy (and saves it); if that fails, or live=False,
    the saved copy in tax_cache/ is used so the demo still works offline."""
    os.makedirs(TAX_CACHE, exist_ok=True)
    meta = os.path.join(TAX_CACHE, "downloaded.json")
    problem = None
    if live:
        try:
            files = {}
            for name in ("state_rates.csv", "jurisdiction_rates.csv"):
                with urllib.request.urlopen(rate_file_url() + name, timeout=25) as r:
                    files[name] = r.read().decode("utf-8")
            for name, text in files.items():
                with open(os.path.join(TAX_CACHE, name), "w", encoding="utf-8", newline="") as f:
                    f.write(text)
            when = datetime.datetime.now().strftime("%b %d, %Y %I:%M %p")
            with open(meta, "w", encoding="utf-8") as f:
                json.dump({"downloaded": when}, f)
            return files["state_rates.csv"], files["jurisdiction_rates.csv"], "live", when, None
        except Exception as e:
            problem = str(e)
    try:
        s = _read_text(os.path.join(TAX_CACHE, "state_rates.csv"))
        j = _read_text(os.path.join(TAX_CACHE, "jurisdiction_rates.csv"))
    except FileNotFoundError:
        raise RuntimeError("Couldn't download the latest rate file" +
                           (f" ({problem})" if problem else "") +
                           " and there is no saved copy yet. Check the internet connection and try again.")
    try:
        with open(meta, encoding="utf-8") as f:
            when = json.load(f).get("downloaded", "an earlier date")
    except Exception:
        when = "an earlier date"
    return s, j, "saved", when, problem

def _rate(v):
    """Parse a rate; ignore anything that isn't a plausible sales-tax rate."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if 0 <= x < 0.2 else None

def _eff(row):
    return (row.get("effective_date") or "").strip()[:10]

def _in_force(rows, today):
    """The row in force today = latest effective_date on or before today."""
    best = None
    for r in rows:
        e = _eff(r)
        if e and e > today:
            continue
        if best is None or e > _eff(best):
            best = r
    return best

def _https(url):
    url = (url or "").strip()
    return url if url.startswith("https://") else ""

def compute_home_rates(state_text, juris_text, today, home):
    """-> ({tax_code: {rate, parts, effective, source}}, state_rate, upcoming) for the home state."""
    st = _in_force([r for r in csv.DictReader(io.StringIO(state_text))
                    if (r.get("state") or "").strip() == home], today)
    state_rate = _rate(st.get("rate")) if st else None
    if state_rate is None:
        raise RuntimeError(f"The rate file has no {home} state rate, so nothing was changed.")

    counties, districts, upcoming, seen_up = {}, {}, [], set()
    for r in csv.DictReader(io.StringIO(juris_text)):
        if (r.get("state") or "").strip() != home or (r.get("rate_type") or "").strip() != "sales":
            continue
        if _rate(r.get("rate")) is None:
            continue
        kind = (r.get("jurisdiction_type") or "").strip()
        fips = (r.get("fips_code") or "").strip()
        if _eff(r) > today and (r.get("name"), _eff(r)) not in seen_up:
            seen_up.add((r.get("name"), _eff(r)))
            upcoming.append({"name": r.get("name") or "", "rate": _rate(r.get("rate")), "effective": _eff(r)})
        if kind == "county" and fips:
            counties.setdefault(fips.zfill(3), []).append(r)
        elif kind == "special_district" and len(fips) == 5 and fips.isdigit():
            districts.setdefault(fips, []).append(r)
        # jurisdiction_type 'transit' is skipped on purpose: it repeats a special_district
        # row (e.g. Mecklenburg's 0.5% transit in NC) and would double-count it.

    out = {}
    for cf, rows in counties.items():
        c = _in_force(rows, today)
        if not c:
            continue
        cname = (c.get("name") or "").strip()
        comps = [(f"{home} state", state_rate, _eff(st), _https(st.get("source_url"))),
                 (f"{cname} County", _rate(c.get("rate")), _eff(c), _https(c.get("source_url")))]
        for df in sorted(districts):
            if df[-3:] != cf:
                continue
            d = _in_force(districts[df], today)
            if not d:
                continue
            label = (d.get("name") or "").strip()
            if not label or label.lower().startswith("special district"):
                label = f"{cname} County local transit tax"
            comps.append((label, _rate(d.get("rate")), _eff(d), _https(d.get("source_url"))))
        latest = max(comps[1:], key=lambda x: x[2])          # newest local component
        out[f"{home}-" + cf] = {"rate": round(sum(x[1] for x in comps), 4),
                           "parts": [{"label": x[0], "rate": x[1]} for x in comps],
                           # newest LOCAL piece (county / transit / district); the state
                           # row's date is the dataset's as-of date, not a rate change
                           "effective": max(x[2] for x in comps[1:]) or None,
                           "source": latest[3] or comps[1][3] or rate_file_url()}
    upcoming.sort(key=lambda u: u["effective"])
    return out, state_rate, upcoming

def _county_key(name):
    return re.sub(r"\s+county$", "", (name or "").strip(), flags=re.I).lower()

def read_overrides(home):
    """Hand-checked rates from tax_rates/tax_rates.csv (State,County,TaxRate,LastUpdated)."""
    out = {}
    try:
        with open(os.path.join(TAX_FOLDER, "tax_rates.csv"), encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if (r.get("State") or "").strip().upper() != home:
                    continue
                rate = _rate(r.get("TaxRate"))
                if rate is not None:
                    out[_county_key(r.get("County"))] = {"rate": rate,
                                                         "checked": (r.get("LastUpdated") or "").strip()}
    except FileNotFoundError:
        pass
    return out

def build_tax_plan(live):
    s, j, how, when, problem = fetch_rate_files(live)
    home = home_state()
    computed, state_rate, upcoming = compute_home_rates(s, j, datetime.date.today().isoformat(), home)
    overrides = read_overrides(home)
    rows = []
    for cur in rowdicts("SELECT tax_code,county,tax_rate,lookup_rate,status FROM tax_code "
                        "WHERE state=:h ORDER BY county", h=home):
        old = float(cur["tax_rate"]) if cur["tax_rate"] is not None else None
        base = {"code": cur["tax_code"], "county": cur["county"], "old": old,
                "function1": float(cur["lookup_rate"]) if cur["lookup_rate"] is not None else None,
                "old_status": cur["status"]}
        comp = computed.get(cur["tax_code"])
        if comp is None:
            rows.append({**base, "found": False, "changed": False, "note": None})
            continue
        new, status, source, note = comp["rate"], "Refreshed", comp["source"], None
        ov = overrides.get(_county_key(cur["county"]))
        if ov:
            if abs(ov["rate"] - comp["rate"]) > 1e-6:
                note = (f"tax_rates.csv says {ov['rate']*100:.2f}% but the rate file says "
                        f"{comp['rate']*100:.2f}%. The hand-checked rate is used; re-check this county with "
                        f"{settings().get('tax_authority', 'the tax authority')}.")
            new, status = ov["rate"], "Verified"
            source = f"Checked by hand - tax_rates.csv ({ov['checked'] or 'no date'})"
        rows.append({**base, "found": True, "new": new, "status": status, "parts": comp["parts"],
                     "effective": comp["effective"], "source": source, "note": note,
                     "changed": old is None or abs(old - new) > 1e-6 or cur["status"] != status})
    return {"how": how, "downloaded": when, "problem": problem, "state_rate": state_rate, "home": home,
            "upcoming": upcoming, "rows": rows, "official_url": settings().get("official_rates_url", "")}

def tax_refresh_preview():
    plan = build_tax_plan(live=True)
    rows = plan.pop("rows")
    found = [r for r in rows if r["found"]]
    plan.update({
        "checked": len(rows),
        "rate_changes": [r for r in found if r["old"] is None or abs(r["old"] - r["new"]) > 1e-6],
        "confirmed": sum(1 for r in found if r["old"] is not None and abs(r["old"] - r["new"]) <= 1e-6),
        "already_current": all(not r["changed"] for r in found),
        "missing": [r["county"] for r in rows if not r["found"]],
        "notes": [{"county": r["county"], "note": r["note"]} for r in found if r["note"]],
    })
    return plan

def tax_refresh_apply():
    plan = build_tax_plan(live=False)           # the same saved file the preview showed
    found = [r for r in plan["rows"] if r["found"]]
    if not found:
        return False, f"The rate file had no {plan['home']} counties, so nothing was changed."
    c = connect()
    try:
        c.run("BEGIN")
        for r in found:
            c.run("UPDATE tax_code SET tax_rate=:r, status=:s, effective_date=CAST(:e AS DATE), "
                  "rate_source=:src, last_refreshed=now() WHERE tax_code=:c",
                  r=r["new"], s=r["status"], e=r["effective"], src=r["source"][:250], c=r["code"])
        c.run("COMMIT")
    except Exception:
        try: c.run("ROLLBACK")
        except Exception: pass
        raise
    finally:
        c.close()
    moved = sum(1 for r in found if r["old"] is None or abs(r["old"] - r["new"]) > 1e-6)
    return True, (f"{plan['home']} tax rates updated: {moved} {'county' if moved == 1 else 'counties'} changed rate, "
                  f"{len(found) - moved} confirmed unchanged. New sales use these rates; "
                  f"past sales keep the tax they were already charged.")

def tax_refresh_revert():
    home = home_state()
    c = connect()
    try:
        c.run("UPDATE tax_code SET tax_rate=lookup_rate, "
              "status=CASE WHEN lookup_rate IS NULL THEN 'Review Required' ELSE 'Provisional' END, "
              "effective_date=NULL, last_refreshed=NULL, rate_source=:s WHERE state=:h",
              s=FUNCTION1_SOURCE, h=home)
        n = c.row_count
    finally:
        c.close()
    return True, (f"{n} {home} counties are back to Function 1's estimates (state + county rate only). "
                  f"Past sales are unchanged.")

def county_problem(tax_code):
    """Friendly reason a county can't be used for a sale, or None.
    Qualifying food is taxed at the county's food rate; counties outside the home
    state have no food rate and are simply not taxed, so any listed county is usable."""
    if not q("SELECT 1 FROM tax_code WHERE tax_code=:c", c=tax_code or "")[1]:
        return "Pick the customer's state and county from the list."
    return None

def _money(data, key):
    """Non-negative dollar amount from the request (blank -> 0)."""
    try:
        v = float(data.get(key, 0) or 0)
    except (TypeError, ValueError):
        raise RuntimeError(f"'{key}' must be a number.")
    if v < 0:
        raise RuntimeError("Amounts can't be negative.")
    return round(v, 2)

def _jars(data, key):
    try:
        v = int(float(data.get(key, 0) or 0))
    except (TypeError, ValueError):
        raise RuntimeError("Jar counts must be whole numbers.")
    if v < 0:
        raise RuntimeError("Jar counts can't be negative.")
    return v

# ---- 3c. CSV EXPORTS  (the "Download CSV" button on every table) -------------
# Each export is the COMPLETE data behind a table (the screen may show a preview),
# read straight from the database views. Product columns and labels are built at
# request time from the product table and business_setting, so nothing is fixed.
LEDGER_TYPES = {"all": "ALL", "sales": "SALE", "batches": "PRODUCTION", "adjustments": "ADJUSTMENT"}
_NUMBER = re.compile(r"-?\d+(\.\d+)?")

def _ident(label):
    """A product name used as a SQL column alias, safely quoted."""
    return '"' + str(label).replace('"', '""') + '"'

def _product_cols(expr_code, qty_expr):
    """One SUM column per product (any number), e.g. "Doctor D's Original jars"."""
    cols, params = [], {}
    for i, (code, r) in enumerate(products_by_code().items()):
        params[f"pc{i}"] = code
        cols.append(f"COALESCE(SUM(CASE WHEN {expr_code} = :pc{i} THEN {qty_expr} END),0) AS "
                    + _ident(r["product_name"] + " jars"))
    return ", ".join(cols), params

def _x_sales(query):
    cols, params = _product_cols("p.product_code", "si.quantity")
    return f"""
        SELECT s.sale_date AS "Date", s.invoice_ref AS "Reference", sc.channel_name AS "Channel",
               t.state AS "State", t.county AS "County", {cols},
               s.item_charge AS "Revenue", s.shipping_revenue AS "Shipping charged", s.state_tax AS "Sales tax",
               s.shopify_fees AS "Card fees", s.shipping_expense AS "Shipping paid", s.product_cost AS "Product cost",
               s.scholarship AS "Scholarship", s.gross_profit AS "Gross profit"
        FROM sale s JOIN sales_channel sc ON sc.channel_id=s.channel_id
        LEFT JOIN tax_code t ON t.tax_code=s.tax_code
        LEFT JOIN sale_item si ON si.sale_id=s.sale_id LEFT JOIN product p ON p.product_id=si.product_id
        GROUP BY s.sale_id, s.sale_date, s.invoice_ref, sc.channel_name, t.state, t.county
        ORDER BY s.sale_date DESC, s.sale_id DESC""", params, ""

def _x_ledger(query):
    t = LEDGER_TYPES.get((query.get("type", ["all"])[0] or "all").lower(), "ALL")
    return """
        SELECT movement_date AS "Date", movement_type AS "Type", product_code AS "Product",
               quantity_change AS "Change (jars)", reference AS "Detail"
        FROM v_inventory_ledger WHERE (CAST(:t AS TEXT) = 'ALL' OR movement_type = CAST(:t AS TEXT))
        ORDER BY movement_date DESC, movement_type""", {"t": t}, ("" if t == "ALL" else "_" + t.lower())

def _x_counts(query):
    return """SELECT product_name AS "Product", system_on_hand AS "System on hand", counted_jars AS "Last counted",
               count_date AS "Count date", variance AS "Difference" FROM v_count_variance""", {}, ""

def _x_monthly(query):
    cols, params = _product_cols("mp.product_code", "mp.jars")
    return f"""
        SELECT to_date(m.month,'MM-DD-YYYY') AS "Month", {cols}, m.jars_sold AS "Jars sold",
               m.revenue AS "Revenue", m.expenses AS "Expenses", m.scholarship_owed AS "Scholarship",
               m.gross_profit AS "Gross profit", ROUND(m.gross_profit / NULLIF(m.revenue,0) * 100, 1) AS "Margin %"
        FROM v_monthly_report m LEFT JOIN v_monthly_product mp ON mp.month = m.month
        GROUP BY m.month, m.jars_sold, m.revenue, m.expenses, m.scholarship_owed, m.gross_profit
        ORDER BY to_date(m.month,'MM-DD-YYYY')""", params, ""

def _x_channels(query):
    return """
        SELECT channel_name AS "Channel", units_sold AS "Jars", revenue AS "Revenue",
               ROUND(revenue / NULLIF(units_sold,0), 2) AS "Avg $ per jar",
               ROUND(units_sold * 100.0 / SUM(units_sold) OVER (), 1) AS "Share of jars %"
        FROM v_sales_by_channel ORDER BY units_sold DESC""", {}, ""

def _x_tax_by_county(query):
    home = home_state()
    return """
        SELECT t.county AS "County", t.tax_code AS "Tax code",
               ROUND(SUM(s.item_charge + s.shipping_revenue), 2) AS "Taxable sales (items + shipping)",
               ROUND(SUM(s.state_tax), 2) AS "Tax collected",
               ROUND(SUM(s.state_tax) / NULLIF(SUM(s.item_charge + s.shipping_revenue),0) * 100, 2) AS "Rate charged %"
        FROM sale s JOIN sales_channel sc ON sc.channel_id=s.channel_id JOIN tax_code t ON t.tax_code=s.tax_code
        WHERE sc.is_taxable AND t.state = :h
        GROUP BY t.county, t.tax_code ORDER BY SUM(s.state_tax) DESC""", {"h": home}, "_" + home.lower()

def _x_scholarship(query):
    names = [r["product_name"] for r in rowdicts("SELECT product_name, is_cobranded FROM product ORDER BY product_id")
             if r["is_cobranded"]]
    others = [r["product_name"] for r in rowdicts("SELECT product_name FROM product WHERE NOT is_cobranded ORDER BY product_id")]
    co = " & ".join(names) or "Co-branded"
    ex = " & ".join(others) or "Other products"
    return f"""
        SELECT to_date(month,'MM-DD-YYYY') AS "Month", cobranded_jars AS {_ident(co + " bottles sold")},
               cobranded_revenue AS {_ident(co + " revenue received")}, scholarship_owed AS "Scholarship owed",
               excluded_jars AS {_ident(ex + " bottles (excluded)")}, excluded_revenue AS {_ident(ex + " revenue (excluded)")}
        FROM v_scholarship_owed ORDER BY to_date(month,'MM-DD-YYYY')""", {}, ""

def _x_tax_rates(query):
    st = (query.get("state", ["ALL"])[0] or "ALL").upper()
    st = st if re.fullmatch(r"[A-Z]{2}", st) else "ALL"
    return """
        SELECT tax_code AS "Tax code", state AS "State", county AS "County", fips_code AS "FIPS",
               food_rate AS "Qualifying-food rate", tax_rate AS "General rate", lookup_rate AS "Function 1 estimate",
               status AS "Status", effective_date AS "Effective", rate_source AS "Source"
        FROM tax_code WHERE (CAST(:st AS TEXT) = 'ALL' OR state = CAST(:st AS TEXT)) ORDER BY state, county""", \
        {"st": st}, "_" + st.lower()

def _x_tax_review(query):
    return """SELECT state AS "State", county AS "County", fips_code AS "FIPS", status AS "Status"
        FROM tax_code WHERE status='Review Required' ORDER BY state, county""", {}, ""

def _x_products(query):                       # Settings tab: the product table
    return """SELECT product_code AS "Code", product_name AS "Product", retail_price AS "Retail price",
        wholesale_price AS "Wholesale price", unit_cost AS "Cost per jar", reorder_level AS "Reorder level",
        lead_time_days AS "Lead time (days)", safety_days AS "Safety days",
        is_qualifying_food AS "Qualifying food", is_cobranded AS "Co-branded",
        ROUND(scholarship_rate*100, 1) AS "Scholarship %" FROM product ORDER BY product_id""", {}, ""

def _x_channel_setup(query):                  # Settings tab: the sales_channel table
    return """SELECT channel_name AS "Channel", is_taxable AS "Taxed", price_basis AS "Default price",
        ships_orders AS "Ships orders", ROUND(fee_pct*100, 2) AS "Card fee %", fee_fixed AS "Fixed fee per order"
        FROM sales_channel ORDER BY channel_id""", {}, ""

def _x_settings(query):                       # Settings tab: business_setting + the home food rate
    return """SELECT setting_key AS "Setting", setting_value AS "Value", description AS "What it controls"
        FROM business_setting
        UNION ALL
        SELECT 'qualifying_food_rate', COALESCE(MAX(ROUND(food_rate*100, 2))::text || '%', 'not set'),
               'Tax rate on qualifying food in every county of the home state'
        FROM tax_code WHERE state = (SELECT setting_value FROM business_setting WHERE setting_key='home_state')
        ORDER BY 1""", {}, ""

EXPORTS = {
    "products": ("products", _x_products), "channel_setup": ("sales_channels_setup", _x_channel_setup),
    "settings": ("business_settings", _x_settings),
    "sales": ("all_sales", _x_sales), "ledger": ("inventory_ledger", _x_ledger),
    "counts": ("stock_count_vs_system", _x_counts), "monthly": ("monthly_report", _x_monthly),
    "channels": ("sales_by_channel", _x_channels), "tax_by_county": ("sales_tax_by_county", _x_tax_by_county),
    "scholarship": ("scholarship_report", _x_scholarship), "tax_rates": ("county_tax_rates", _x_tax_rates),
    "tax_review": ("tax_records_flagged_for_review", _x_tax_review),
}

def _csv_cell(v):
    """Format one value for a spreadsheet; neutralise text that Excel would run as a formula."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, decimal.Decimal):
        return format(v, "f")
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()[:19].replace("T", " ")
    if isinstance(v, (int, float)):
        return str(v)
    t = str(v)
    if t[:1] in ("=", "+", "@", "\t", "\r") or (t[:1] == "-" and not _NUMBER.fullmatch(t)):
        t = "'" + t
    return t

def export_csv(name, query):
    """-> (filename, utf-8 bytes with a BOM so Excel shows names and dashes correctly)."""
    if name not in EXPORTS:
        raise RuntimeError("Unknown export.")
    base, build = EXPORTS[name]
    sql, params, suffix = build(query)
    cols, rows = q(sql, **params)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(cols)
    for r in rows:
        w.writerow([_csv_cell(v) for v in r])
    fname = f"doctords_{base}{suffix}_{datetime.date.today().isoformat()}.csv"
    return fname, ("﻿" + buf.getvalue()).encode("utf-8")

# ---- 4. WEB SERVER ----------------------------------------------------------
def _json_default(o):
    if isinstance(o, decimal.Decimal): return float(o)
    if isinstance(o, (datetime.date, datetime.datetime)): return o.isoformat()
    return str(o)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, default=_json_default).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name, ctype):
        path = os.path.join(HERE, name)
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_response(404); self.end_headers()
            self.wfile.write(b"Not found"); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/index.html"):
                self._send_file("index.html", "text/html; charset=utf-8")
            elif path == "/app.js":
                self._send_file("app.js", "application/javascript; charset=utf-8")
            elif path == "/api/bootstrap":
                self._send_json(bootstrap())
            elif path.startswith("/api/export/") and path.endswith(".csv"):
                fname, body = export_csv(path[len("/api/export/"):-4], urllib.parse.parse_qs(parsed.query))
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/tax/refresh/preview":
                self._send_json(tax_refresh_preview())
            elif path == "/api/tax":
                st = urllib.parse.parse_qs(parsed.query).get("state", [home_state()])[0]
                self._send_json({"state": st, "counties": tax_counties(st)})
            else:
                self.send_response(404); self.end_headers(); self.wfile.write(b"Not found")
        except RuntimeError as e:                       # our own plain-language messages
            self._send_json({"error": str(e)}, 500)
        except Exception as e:
            self._send_json({"error": "Database error: " + pgmsg(e)}, 500)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {}
        route = urllib.parse.urlparse(self.path).path
        try:
            if route == "/api/tax/refresh/apply":
                ok, msg = tax_refresh_apply()
                return self._send_json({"ok": ok, "message": msg})
            if route == "/api/tax/refresh/revert":
                ok, msg = tax_refresh_revert()
                return self._send_json({"ok": ok, "message": msg})

            if route == "/api/settings/product":
                ok, msg = save_product(data)
                return self._send_json({"ok": ok, "message": msg})
            if route == "/api/settings/channel":
                ok, msg = save_channel(data)
                return self._send_json({"ok": ok, "message": msg})
            if route == "/api/settings/business":
                ok, msg = save_business(data)
                return self._send_json({"ok": ok, "message": msg})

            prods = {code: r["product_id"] for code, r in products_by_code().items()}

            if route == "/api/sale":
                # One order: jars + price per product, plus (for shipped orders) what the
                # customer paid for shipping and what the label actually cost. Tax, card
                # fee, scholarship and profit are all derived by fn_finalize_sale.
                items = []
                for it in data.get("items") or []:
                    code = str(it.get("code", ""))
                    if code not in prods:
                        raise RuntimeError(f"Unknown product '{code}'.")
                    n = _jars(it, "jars")
                    if n:
                        items.append((prods[code], n, _money(it, "price")))
                if not items:
                    return self._send_json({"ok": False, "message": "Enter at least one jar."})
                bad = county_problem(data.get("county"))
                if bad:
                    return self._send_json({"ok": False, "message": bad})
                ok, msg, extra = record_sales([{
                    "channel": int(data["channel"]), "county": data["county"], "items": items,
                    "ship_rev": _money(data, "ship_rev"), "ship_exp": _money(data, "ship_exp"),
                    "prefix": "APP"}], label="Sale")
                return self._send_json({"ok": ok, "message": msg, "data": extra})

            if route == "/api/market":
                # End-of-market summary: a cash part and a card part, each = jars per product
                # + the total collected. Money is split between products by jar share (the
                # owner can't tell singles from 2-for-$18 deals). The card part carries the
                # processing fee from the card-reader payout. Saved all-or-nothing.
                bad = county_problem(data.get("county"))
                if bad:
                    return self._send_json({"ok": False, "message": bad})
                mkt = settings().get("market_channel", "")
                found = q("SELECT channel_id FROM sales_channel WHERE channel_name=:n", n=mkt)[1]
                if not found:
                    raise RuntimeError(f"The market channel '{mkt}' (business_setting) doesn't exist.")
                ch, codes, parts = found[0][0], list(prods), []
                for kind in ("cash", "card"):
                    part = data.get(kind) or {}
                    jars = part.get("jars") or {}
                    counts = [_jars(jars, code) for code in codes]
                    total = _money(part, "total")
                    if not sum(counts):
                        if total:
                            raise RuntimeError(f"You entered {kind} money but no {kind} jars.")
                        continue
                    revs = split_by_share(total, counts)
                    items = [(prods[code], n, round(rv / n, 6)) for code, n, rv in zip(codes, counts, revs) if n]
                    parts.append({"channel": ch, "county": data["county"], "items": items,
                                  "fee": _money(part, "fee") if kind == "card" else 0,
                                  "prefix": "MKT-CASH" if kind == "cash" else "MKT-CARD"})
                if not parts:
                    return self._send_json({"ok": False, "message": "Enter at least one jar."})
                ok, msg, extra = record_sales(parts, label="Market day")
                return self._send_json({"ok": ok, "message": msg, "data": extra})

            if route == "/api/restock":
                ok, msg, extra = add_batch(int(prods[data["product"]]),
                                           int(data.get("jars", 1) or 1), data.get("code", "B-NEW"))
                return self._send_json({"ok": ok, "message": msg, "data": extra})

            if route == "/api/adjust":
                jars = abs(int(data.get("jars", 0) or 0))
                direction = 1 if str(data.get("direction", "loss")).lower() == "gain" else -1
                qty = direction * jars
                if qty == 0:
                    return self._send_json({"ok": False, "message": "Enter a number of jars."})
                ok, msg, extra = record_adjustment(int(prods[data["product"]]), qty,
                                                   data.get("reason", "Other"), data.get("note", ""))
                return self._send_json({"ok": ok, "message": msg, "data": extra})

            if route == "/api/count":
                ok, msg, extra = record_count(int(prods[data["product"]]),
                                              int(data.get("counted", 0) or 0),
                                              data.get("note", ""), bool(data.get("reconcile")))
                return self._send_json({"ok": ok, "message": msg, "data": extra})

            self.send_response(404); self.end_headers(); self.wfile.write(b"Not found")
        except RuntimeError as e:
            self._send_json({"ok": False, "message": str(e)}, 200)
        except Exception as e:
            self._send_json({"ok": False, "message": pgmsg(e)}, 200)

def main():
    try:
        q("SELECT 1")
        print("\n  Connected to database OK.")
    except Exception as e:
        print("\n  !! Could not connect to the database.")
        print("  !! Put the database password in local_settings.json (or set DD_DB_PASSWORD).")
        print(f"  !! {e}\n")
    url = f"http://localhost:{PORT}"
    print(f"  Doctor D's Console running at:  {url}")
    print("  Press Ctrl+C to stop.\n")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    with http.server.ThreadingHTTPServer(("", PORT), Handler) as srv:
        try: srv.serve_forever()
        except KeyboardInterrupt: print("\n  Stopped.")

if __name__ == "__main__":
    main()

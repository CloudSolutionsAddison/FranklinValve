# Auto-Lot Utility Library — Developer Reference

## Overview

`bpc_fv_auto_lot_util.js` is a SuiteScript 2.1 utility module that automates lot assignment on NetSuite transactions. It handles the entire lifecycle of inventory detail generation: querying available lots, choosing which lots to consume, writing those choices into the Inventory Detail subrecord on a transaction line, and clearing them when needed.

The module is imported as a dependency via `define()` and exposes a clean public API of stateless, composable functions.

```js
define(['./bpc_fv_auto_lot_util'], function (util) {
    // util.getAvailableLots(...)
    // util.selectLots(...)
    // util.writeInventoryDetail(...)
    // etc.
});
```

---

## The Core Data Pipeline

Almost every consuming script follows a three-step pipeline:

```
Step 1 — QUERY        →  getAvailableLots(itemId, locationId)
Step 2 — DECIDE       →  selectLots(lots, requiredQty)
Step 3 — WRITE        →  writeInventoryDetail(rec, sublistId, lineIdx, lotLines, options)
```

Each step produces the exact data shape the next step expects, so they chain together directly with no transformation in between.

---

## Public API Reference

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_BIN` | `'11-QA-INSP'` | Default bin assigned on every lot-tracked Item Receipt line. |
| `DEFAULT_INV_STATUS` | `'Good'` | Default inventory status assigned on receipt. |
| `VENDOR_PART_NUM_RECORD` | `'customrecord_bpc_fv_vpn'` | Internal ID of the Vendor Part Number custom record type. |
| `VPN_FIELDS` | `{ VENDOR, ITEM, VENDOR_CODE, IS_INACTIVE }` | Field IDs on the Vendor Part Number custom record. |

---

### Guard Functions

#### `isLotNumbered(itemId)`

Determines whether an item uses lot tracking. Uses `search.lookupFields` against the generic `'item'` type, so it works for both Inventory Items and Assembly Items without knowing the item's type in advance.

**Returns:** `boolean`

```js
if (!util.isLotNumbered(itemId)) {
    log.debug('Skipping', 'Item ' + itemId + ' is not lot-numbered');
    return;
}
```

#### `isSerializedAssembly(itemId)`

Determines whether an item is both serialized AND an assembly. Serialized assembly items are excluded from all auto-lot/serial assignment logic — serial selection is entirely manual. In NetSuite, lot-numbered and serialized are mutually exclusive on an item, but this explicit check is provided for clarity and produces a distinct log message that aids troubleshooting.

**Returns:** `boolean`

```js
if (util.isSerializedAssembly(itemId)) {
    log.debug('Skipping', 'Item ' + itemId + ' is a serialized assembly — manual assignment');
    return;
}
```

---

### Vendor Code Lookup

#### `lookupVendorCode(vendorId, itemId)`

Searches the Vendor Part Number custom record (`customrecord_bpc_fv_vpn`) to find the vendor code for a specific vendor–item combination. Returns the first matching active record's vendor code.

**Parameters:**

- `vendorId` (number|string) — Internal ID of the vendor entity.
- `itemId` (number|string) — Internal ID of the inventory item.

**Returns:** `string|null` — The vendor code, or `null` if no mapping exists.

```js
var vendorCode = util.lookupVendorCode(vendorId, itemId);
// Returns something like 'ABC' or null

// Typical use: build a lot name on an Item Receipt
var lotName = vendorCode + '-' + dateStr + '-' + seqNum;
// e.g. 'ABC-20240115-001'
```

---

### Step 1 — Querying Available Lots

#### `getAvailableLots(itemId, locationId, options)`

Runs a SuiteQL query against `InventoryBalance` joined to `InventoryNumber` to find every lot for the given item at the given location that has positive available quantity and a `'Good'` inventory status.

**Parameters:**

- `itemId` (number|string) — Internal ID of the item. **Required.**
- `locationId` (number|string) — Internal ID of the location. **Required.** NetSuite's `issueinventorynumber` field on a WO line only offers lots at that line's location, so the query must be scoped to exactly that location.
- `options` (object, optional):
  - `includeInspectionBins` (boolean, default `false`) — When `true`, non-issuable bins (e.g. `11-QA-INSP`) are NOT excluded from the results.

**Returns:** An array sorted ascending by available quantity, then alphabetically by lot number:

```js
[
    { lotNumber: 'LOT-2024-001', lotId: '4501', availableQty: 25 },
    { lotNumber: 'LOT-2024-002', lotId: '4502', availableQty: 10 },
    { lotNumber: 'LOT-2024-003', lotId: '4503', availableQty: 50 }
]
```

**Key behaviors:**

- Returns an empty array and logs an error if either `itemId` or `locationId` is missing, invalid, or non-positive.
- By default, excludes stock sitting in inspection/receiving bins (`11-QA-INSP`). That stock shows as "available" in `InventoryBalance` but cannot actually be issued to a Work Order.
- Filters to only `'Good'` inventory status (or null/unset). Lots in QA-Hold or Damaged are rejected by NetSuite even with a valid ID.
- Internally uses a fallback: runs a bin-unaware query first, and if that fails, retries with bin-aware filtering.

**Example — Work Order Issue (exclude QA bins):**

```js
var lots = util.getAvailableLots(itemId, locationId);
// Returns only lots in issuable bins — the default behavior
```

**Example — Item Receipt (include QA bins):**

```js
var lots = util.getAvailableLots(itemId, locationId, { includeInspectionBins: true });
// Returns ALL lots including those in 11-QA-INSP
```

---

### Step 2 — Lot Selection Strategies

The library offers four selection algorithms. All four share an identical input/output contract, so they can be swapped without changing anything else in the calling script.

**Shared Input:**

- `lots` — The array returned by `getAvailableLots`.
- `requiredQty` (number) — The quantity needed on the transaction line.

**Shared Output:**

```js
{
    success: true,             // false if stock is insufficient
    lines: [
        { lotNumber: 'LOT-A', lotId: '101', qty: 10 },
        { lotNumber: 'LOT-B', lotId: '102', qty: 5 }
    ],
    shortfall: 0               // units that couldn't be covered (> 0 when success is false)
}
```

When `success` is `false`, the `lines` array is empty and `shortfall` indicates how many units are missing.

---

#### `selectLots(lots, requiredQty)` — Default Strategy (Lowest Bin First)

This is a wrapper that delegates to Strategy 4 (Lowest Bin First). It is the recommended default for most use cases.

**Algorithm:**

1. Check for a single lot that exactly matches `requiredQty`. If found, return it.
2. Sort ascending by `availableQty`. On ties, sort ascending by `lotNumber`.
3. Draw sequentially from the smallest lot upward until the required quantity is met.
4. If total available stock is insufficient, return `{ success: false, shortfall: N }`.

**Design intent:** Consume small, partial lots first and keep large lots intact for bigger future orders.

**Example walkthrough:**

Given these available lots:

| Lot | Available Qty |
|---|---|
| LOT-A | 5 |
| LOT-B | 12 |
| LOT-C | 50 |

Required quantity: **15**

No exact match exists. Sorted ascending (already in order). Draw 5 from LOT-A (exhausted), then 10 from LOT-B:

```js
var selection = util.selectLots(lots, 15);
// Result:
// {
//     success: true,
//     lines: [
//         { lotNumber: 'LOT-A', lotId: '101', qty: 5 },
//         { lotNumber: 'LOT-B', lotId: '102', qty: 10 }
//     ],
//     shortfall: 0
// }
```

LOT-C (50 units) is untouched and remains available for a larger future order.

---

#### `selectLotsGreedyMax(lots, requiredQty)` — Fewest Lots

**Algorithm:**

1. Check for a single lot that exactly matches `requiredQty`.
2. Sort remaining lots descending by `availableQty`.
3. Draw sequentially from the largest lot downward (fewest lots consumed).
4. Return shortfall if insufficient.

**Design intent:** Minimize the number of lot lines on the transaction. Fewer lots means simpler paperwork and traceability, at the cost of potentially fragmenting a large lot.

**Same example (required = 15):**

After sorting descending: LOT-C (50), LOT-B (12), LOT-A (5). Draws 15 from LOT-C in a single line:

```js
var selection = util.selectLotsGreedyMax(lots, 15);
// Result:
// {
//     success: true,
//     lines: [
//         { lotNumber: 'LOT-C', lotId: '103', qty: 15 }
//     ],
//     shortfall: 0
// }
```

---

#### Internal Strategies (Not Directly Exposed)

**Strategy 1 — Original:** Exact-match first, then sequential draw in system-default order. No sorting, no lot-count minimization.

**Strategy 3 — Optimised:** Exact match → smallest single lot that still covers the full quantity (best-fit) → descending draw. Minimizes lot count AND preserves inventory flexibility by not locking up a huge lot when a smaller one suffices. For example, if LOT-B had 18 available and the required quantity is 15, the optimised strategy would prefer LOT-B (18) over LOT-C (50) because 18 is closer to 15 — preserving LOT-C for bigger orders.

---

### Step 3 — Writing Inventory Detail

#### `writeInventoryDetail(rec, sublistId, lineIdx, lotLines, options)`

Opens the Inventory Detail subrecord on the specified transaction line, clears any existing assignment lines (NetSuite sometimes auto-populates them), and writes the lot assignments from the selection result.

**Parameters:**

- `rec` (Record) — The transaction record object (e.g. the Work Order or Item Receipt being modified in `beforeSubmit`).
- `sublistId` (string) — Which sublist the line lives on: `'item'` for most transactions, `'component'` for Work Order component lines.
- `lineIdx` (number) — The zero-based line index on that sublist.
- `lotLines` (Array) — The `.lines` array from a `selectLots` or `selectLotsGreedyMax` result. Each element must have `{ lotNumber, lotId, qty }`.
- `options` (object, optional):
  - `isReceipt` (boolean) — When `true`, also writes the `receiptinventorynumber` field (the lot name string) in addition to `issueinventorynumber`. Used when creating new lots on Item Receipts.
  - `binName` (string) — Bin internal ID or name to set on each assignment line (typically for receiving).
  - `invStatus` (string) — Inventory status to set on each assignment line.

**Internal behavior:**

1. Opens the Inventory Detail subrecord via `rec.getSublistSubrecord(...)`.
2. Throws `FV_LOT_NO_INVDETAIL` if the subrecord cannot be opened.
3. Clears all existing assignment lines (loops backward with `removeLine`).
4. For each entry in `lotLines`, inserts a new line and sets:
   - `issueinventorynumber` → `lotLines[k].lotId` (internal ID of the lot)
   - `receiptinventorynumber` → `lotLines[k].lotNumber` (only when `isReceipt` is `true`)
   - `quantity` → `lotLines[k].qty`
   - `binnumber` → `options.binName` (if provided)
   - `inventorystatus` → `options.invStatus` (if provided)

**Example — Issuing lots on a Work Order component line:**

```js
var lots = util.getAvailableLots(itemId, locationId);
var selection = util.selectLots(lots, componentQty);

if (selection.success) {
    util.writeInventoryDetail(rec, 'component', lineIndex, selection.lines);
}
```

**Example — Receiving with a new lot on an Item Receipt:**

```js
var newLotLines = [{
    lotNumber: 'VND-20240115-001',
    lotId:     'VND-20240115-001',
    qty:       100
}];

util.writeInventoryDetail(rec, 'item', lineIndex, newLotLines, {
    isReceipt: true,
    binName:   util.DEFAULT_BIN,         // '11-QA-INSP'
    invStatus: util.DEFAULT_INV_STATUS   // 'Good'
});
```

---

### Clearing Inventory Detail

#### `clearInventoryDetail(rec, sublistId, lineIdx)`

Removes all existing inventory assignment lines from a transaction line's Inventory Detail subrecord.

**When to use:** When a line's lot selection must be wiped — for example, the ordered quantity changed and the previously selected lots no longer cover it, or a manual override is needed.

**Parameters:**

- `rec` (Record) — The transaction record.
- `sublistId` (string) — e.g. `'item'`, `'component'`.
- `lineIdx` (number) — Line index on the sublist.

**Safe to call** even if the line has no inventory detail or no existing assignment lines — it silently returns without error.

```js
// Quantity changed — wipe the stale lot assignment and re-select
util.clearInventoryDetail(rec, 'component', lineIndex);

var lots = util.getAvailableLots(itemId, locationId);
var selection = util.selectLots(lots, newQty);
if (selection.success) {
    util.writeInventoryDetail(rec, 'component', lineIndex, selection.lines);
}
```

---

## Full End-to-End Examples

### Example 1: Work Order Component Auto-Lot Assignment (beforeSubmit)

This User Event script loops through every component line on a Work Order, checks whether the item is lot-tracked, queries available lots, selects lots using the default strategy, and writes them into the Inventory Detail subrecord.

```js
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['./bpc_fv_auto_lot_util'], function (util) {

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        var rec = context.newRecord;
        var componentCount = rec.getLineCount({ sublistId: 'component' });

        for (var i = 0; i < componentCount; i++) {
            var itemId = rec.getSublistValue({
                sublistId: 'component', fieldId: 'item', line: i
            });

            // Guard: only process lot-numbered, non-serialized items
            if (!util.isLotNumbered(itemId)) { continue; }
            if (util.isSerializedAssembly(itemId)) { continue; }

            var locationId = rec.getSublistValue({
                sublistId: 'component', fieldId: 'location', line: i
            });
            var requiredQty = parseFloat(rec.getSublistValue({
                sublistId: 'component', fieldId: 'quantity', line: i
            }));

            // Step 1: Query available lots at this location
            var lots = util.getAvailableLots(itemId, locationId);

            if (lots.length === 0) {
                log.audit('AutoLot', 'No lots available for item ' + itemId +
                          ' at location ' + locationId + ' — skipping line ' + i);
                continue;
            }

            // Step 2: Select lots using the default strategy (Lowest Bin First)
            var selection = util.selectLots(lots, requiredQty);

            if (!selection.success) {
                log.error('AutoLot', 'Insufficient stock for item ' + itemId +
                          ': shortfall=' + selection.shortfall);
                util.clearInventoryDetail(rec, 'component', i);
                continue;
            }

            // Step 3: Write the lot selection into Inventory Detail
            util.writeInventoryDetail(rec, 'component', i, selection.lines);
        }
    }

    return { beforeSubmit: beforeSubmit };
});
```

---

### Example 2: Item Receipt with New Lot Creation (beforeSubmit)

This User Event script generates a new lot name for each lot-tracked line on an Item Receipt, using the vendor code from the Vendor Part Number custom record, and writes it into the Inventory Detail subrecord along with the default bin and status.

```js
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['./bpc_fv_auto_lot_util'], function (util) {

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.CREATE) { return; }

        var rec = context.newRecord;
        var vendorId = rec.getValue({ fieldId: 'entity' });
        var lineCount = rec.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < lineCount; i++) {
            var itemId = rec.getSublistValue({
                sublistId: 'item', fieldId: 'item', line: i
            });

            if (!util.isLotNumbered(itemId)) { continue; }

            var qty = parseFloat(rec.getSublistValue({
                sublistId: 'item', fieldId: 'quantity', line: i
            }));

            // Build the lot name: VendorCode-Date-Seq
            var vendorCode = util.lookupVendorCode(vendorId, itemId) || 'UNK';
            var today = new Date();
            var dateStr = today.getFullYear().toString() +
                          ('0' + (today.getMonth() + 1)).slice(-2) +
                          ('0' + today.getDate()).slice(-2);
            var lotName = vendorCode + '-' + dateStr + '-' + ('00' + (i + 1)).slice(-3);

            // Write the new lot into Inventory Detail
            var lotLines = [{
                lotNumber: lotName,
                lotId:     lotName,
                qty:       qty
            }];

            util.writeInventoryDetail(rec, 'item', i, lotLines, {
                isReceipt: true,
                binName:   util.DEFAULT_BIN,         // '11-QA-INSP'
                invStatus: util.DEFAULT_INV_STATUS   // 'Good'
            });
        }
    }

    return { beforeSubmit: beforeSubmit };
});
```

---

### Example 3: Re-Selecting Lots After a Quantity Change

When a component quantity is edited, the previously assigned lots may no longer be valid. This pattern clears the stale assignment and re-runs the pipeline:

```js
// Detect quantity change
var oldQty = parseFloat(context.oldRecord.getSublistValue({
    sublistId: 'component', fieldId: 'quantity', line: i
}));
var newQty = parseFloat(context.newRecord.getSublistValue({
    sublistId: 'component', fieldId: 'quantity', line: i
}));

if (oldQty !== newQty) {
    // Wipe the stale assignment
    util.clearInventoryDetail(rec, 'component', i);

    // Re-run the full pipeline
    var lots = util.getAvailableLots(itemId, locationId);
    var selection = util.selectLots(lots, newQty);

    if (selection.success) {
        util.writeInventoryDetail(rec, 'component', i, selection.lines);
    } else {
        log.error('AutoLot', 'Cannot cover new qty ' + newQty +
                  ' for item ' + itemId + ': shortfall=' + selection.shortfall);
    }
}
```

---

### Example 4: Using the Greedy Max Strategy

When minimizing the number of lot lines on a transaction is more important than preserving small lots, swap the selection call:

```js
// Instead of:
var selection = util.selectLots(lots, requiredQty);

// Use:
var selection = util.selectLotsGreedyMax(lots, requiredQty);

// Everything else (getAvailableLots, writeInventoryDetail) stays identical.
// The output contract is the same, so no downstream changes are needed.
```

---

## Strategy Comparison Matrix

| Scenario | `selectLots` (Lowest Bin First) | `selectLotsGreedyMax` (Fewest Lots) |
|---|---|---|
| Lots: A=5, B=12, C=50; Need: 15 | A (5) + B (10) = 2 lots; C untouched | C (15) = 1 lot; A and B untouched |
| Lots: A=15; Need: 15 | A (15) = exact match, 1 lot | A (15) = exact match, 1 lot |
| Lots: A=3, B=3, C=3; Need: 10 | All three exhausted, shortfall = 1 | All three exhausted, shortfall = 1 |
| Lots: A=100; Need: 5 | A (5) = 1 lot | A (5) = 1 lot |
| Lots: A=4, B=4, C=100; Need: 8 | A (4) + B (4) = 2 lots; C untouched | C (8) = 1 lot; A and B untouched |

---

## API Quick Reference

| Function | Purpose | Typical Use |
|---|---|---|
| `isLotNumbered(itemId)` | Returns `true` if the item uses lot tracking. | Guard — skip non-lot items. |
| `isSerializedAssembly(itemId)` | Returns `true` if the item is serialized + assembly. | Guard — skip serial assemblies. |
| `lookupVendorCode(vendorId, itemId)` | Returns the vendor code from the VPN custom record. | Building lot names on Item Receipts. |
| `getAvailableLots(itemId, locationId, opts)` | Queries all lots with positive issuable qty. | Pipeline Step 1. |
| `selectLots(lots, requiredQty)` | Picks lots using lowest-bin-first (default). | Pipeline Step 2 — issue/consumption. |
| `selectLotsGreedyMax(lots, requiredQty)` | Picks lots using largest-first. | Pipeline Step 2 — minimize lot count. |
| `writeInventoryDetail(rec, sublistId, lineIdx, lotLines, opts)` | Writes lot assignments into Inventory Detail. | Pipeline Step 3. |
| `clearInventoryDetail(rec, sublistId, lineIdx)` | Removes all assignment lines from Inventory Detail. | Re-selecting or wiping stale assignments. |
| `DEFAULT_BIN` | `'11-QA-INSP'` | Pass as `binName` on receipts. |
| `DEFAULT_INV_STATUS` | `'Good'` | Pass as `invStatus` on receipts. |

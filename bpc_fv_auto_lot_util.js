/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Franklin Valve — Auto Lot Utility Module
 * Shared helpers for lot assignment and lot consumption across all
 * auto-lot user-event scripts.
 *
 * Functional Design Ref: Franklin Valve Inv Lot Traceability FDD v0.3
 *
 * @module fv_auto_lot_util
 */
define([
    'N/search',
    'N/query',
    'N/log',
    'N/error'
], function (search, query, log, error) {

    /* ------------------------------------------------------------------ *
     *  CONSTANTS                                                          *
     * ------------------------------------------------------------------ */

    /**
     * Internal ID of the Vendor Part Number custom record type.
     * Update this constant after the record is created in the target account.
     */
    const VENDOR_PART_NUM_RECORD = 'customrecord_bpc_fv_vpn';

    /** Field IDs on the Vendor Part Number custom record */
    const VPN_FIELDS = {
        VENDOR:      'name',
        ITEM:        'custrecord_bpc_fv_vpn_item',
        VENDOR_CODE: 'custrecord_bpc_ui_vendorlist',
        IS_INACTIVE: 'isinactive'
    };

    /** Default bin assigned on every lot-tracked Item Receipt line */
    const DEFAULT_BIN = '11-QA-INSP';

    /** Default inventory status assigned on receipt */
    const DEFAULT_INV_STATUS = 'Good';

    /**
     * Bin names that hold non-issuable stock (inspection / receiving).
     * Stock in these bins shows as "available" in InventoryBalance but
     * cannot be issued to a Work Order — exclude them from lot queries.
     */
    const NON_ISSUABLE_BINS = [DEFAULT_BIN];   // ['11-QA-INSP']


    /* ------------------------------------------------------------------ *
     *  VENDOR CODE LOOKUP  (FR-02, FR-03)                                 *
    /**
     * Look up the Vendor Code for a given vendor + item combination
     * from the Vendor Part Number custom record.
     *
     * @param {number|string} vendorId  - Internal ID of the vendor (entity)
     * @param {number|string} itemId    - Internal ID of the inventory item
     * @returns {string|null}           - Vendor Code, or null if not found
     */
    function lookupVendorCode(vendorId, itemId) {
        log.debug('lookupVendorCode', 'vendor=' + vendorId + ' item=' + itemId);

        var vendorCode = null;

        var s = search.create({
            type: VENDOR_PART_NUM_RECORD,
            filters: [
                [VPN_FIELDS.VENDOR, 'anyof', vendorId],
                'AND',
                [VPN_FIELDS.ITEM, 'anyof', itemId],
                'AND',
                [VPN_FIELDS.IS_INACTIVE, 'is', 'F']
            ],
            columns: [VPN_FIELDS.VENDOR_CODE]
        });

        s.run().each(function (result) {
            vendorCode = result.getValue(VPN_FIELDS.VENDOR_CODE);
            return false; // first match only
        });

        log.debug('lookupVendorCode', 'result=' + vendorCode);
        return vendorCode;
    }

    /* ------------------------------------------------------------------ *
     *  LOT SELECTION ALGORITHM  (FR-10, FR-11, KBD-05, KBD-06)           *
     * ------------------------------------------------------------------ */

    /**
     * Query available lot quantities for a lot-numbered item at a location.
     *
     * Returns an array sorted by ascending available qty then lot number,
     * which feeds the "lowest bin first" selection strategy.
     *
     * @param {number|string} itemId     - Internal ID of the item
     * @param {number|string} locationId - Internal ID of the location
     * @param {object}  [options]
     * @param {boolean} [options.includeInspectionBins=false] - When true,
     *        non-issuable bins (QA-INSP etc.) are NOT excluded.
     * @returns {Array<{lotNumber: string, lotId: string, availableQty: number}>}
     */
    function getAvailableLots(itemId, locationId, options) {
        options = options || {};
        var lots = [];

        var parsedItem = parseInt(itemId, 10);
        var parsedLoc  = parseInt(locationId, 10);

        if (isNaN(parsedItem) || parsedItem <= 0) {
            log.error('getAvailableLots', 'Invalid itemId: ' + itemId);
            return lots;
        }

        /*
         * Location scoping is MANDATORY.  The issueinventorynumber field on a
         * WO line only offers lots that exist AT THE LINE'S LOCATION, so the
         * query must be scoped to exactly that location — never a broader or
         * different one — or valid-looking lots will be rejected downstream.
         */
        if (isNaN(parsedLoc) || parsedLoc <= 0) {
            log.error('getAvailableLots',
                'No valid location for item ' + itemId +
                ' — cannot query lots without a location.');
            return lots;
        }

        /*
         * Decide whether to exclude inspection / receiving bins.  Default:
         * exclude them, because stock in those bins is not issuable to a WO
         * even though it shows as "available" in the balance.
         */
        var excludeInspection =
            options.includeInspectionBins !== true &&
            NON_ISSUABLE_BINS.length > 0;

        /* ── Build the bin-aware query ──
         * Grain is bin + status so we can (a) drop inspection bins and
         * (b) compute a genuinely assignable quantity, then roll up to lot.
         */
        function buildSql(withBinExclusion) {
            var s =
                "SELECT invNum.id              AS lotid, " +
                "       invNum.inventorynumber  AS lotnumber, " +
                "       SUM(invBal.quantityavailable) AS available " +
                "FROM   InventoryBalance invBal " +
                "JOIN   InventoryNumber  invNum " +
                "  ON   invBal.inventorynumber = invNum.id ";

            if (withBinExclusion) {
                s += "LEFT JOIN Bin bin ON invBal.binnumber = bin.id ";
            }

            s +=
                "WHERE  invBal.item     = ? " +
                "  AND  invBal.location = ? ";

            /* Issuable status only ('Good' / default / unset).  A lot in
             * QA-Hold or Damaged is rejected by NetSuite even with a valid ID.
             *
             * Uses BUILTIN.DF() to resolve the display name of the status
             * foreign key — avoids querying the InventoryStatus table directly,
             * which is not exposed as a standalone SuiteQL table in all accounts. */
            s +=
                "  AND  (invBal.inventorystatus IS NULL " +
                "        OR BUILTIN.DF(invBal.inventorystatus) = ?) ";

            if (withBinExclusion) {
                var placeholders = NON_ISSUABLE_BINS.map(function () { return '?'; }).join(', ');
                s +=
                    "  AND  (invBal.binnumber IS NULL " +
                    "        OR bin.binnumber NOT IN (" + placeholders + ")) ";
            }

            s +=
                "GROUP  BY invNum.id, invNum.inventorynumber " +
                "HAVING SUM(invBal.quantityavailable) > 0 " +
                "ORDER  BY SUM(invBal.quantityavailable) ASC, invNum.inventorynumber ASC";

            return s;
        }

        function runQuery(withBinExclusion) {
            var sql    = buildSql(withBinExclusion);
            var params = [parsedItem, parsedLoc, DEFAULT_INV_STATUS];
            if (withBinExclusion) {
                params = params.concat(NON_ISSUABLE_BINS);
            }
            log.debug('getAvailableLots sql', sql);
            log.debug('getAvailableLots params',
                JSON.stringify(params) + ' | binExclusion=' + withBinExclusion);
            return query.runSuiteQL({ query: sql, params: params }).asMappedResults();
        }

        /*
         * Run the bin-independent  query.  If it throws error fall back to the bin-aware query
         * the try/catch on the WO write side remains the final safety net.
         */
        var results;
        try {
            results = runQuery(false);
        } catch (qErr) {
            if (excludeInspection) {
                log.audit('getAvailableLots',
                    'Bin-unaware query failed (' + qErr.name + ': ' + qErr.message +
                    '). Trying the bin based query — verify the Bin ' +
                    'table/field names for this account.');
                results = runQuery(true);
            } else {
                throw qErr;
            }
        }


        for (var i = 0; i < results.length; i++) {
            /*
             * quantityavailable is NetSuite's on-hand-minus-committed figure.
             * With inspection/receiving bins already excluded above, this is
             * the assignable quantity for the issueinventorynumber field.
             */
            var assignable = parseFloat(results[i].available) || 0;

            if (assignable <= 0) { continue; }

            lots.push({
                lotNumber:    results[i].lotnumber,
                lotId:        String(results[i].lotid),
                availableQty: assignable
            });
        }

        log.debug('getAvailableLots lots is', JSON.stringify(lots));
        log.debug('getAvailableLots',
            'item=' + itemId + ' loc=' + locationId +
            ' lots=' + lots.length + ' binExclusion=' + excludeInspection);
        return lots;
    }

    /**
     *
     * Strategy 1 – Original   : Exact-match first, then sequential draw (system order).
     * Strategy 2 – Greedy Max  : Sort descending by qty, then sequential draw (fewest lots).
     * Strategy 3 – Optimised   : Exact → smallest-sufficient single lot → descending draw.
     * Strategy 4 – Lowest Bin First:  ascending qty, tie → lotNumber
     * All 4 share the same input / output contract.
     *
     * @module lotSelection
     */

    /* ------------------------------------------------------------------ */
    /*  Strategy 1 – Original (system-default order)                      */
    /* ------------------------------------------------------------------ */

    /**
     * Select lot(s) using the original algorithm:
     *   1. Prefer a single exact-match lot.
     *   2. Otherwise draw sequentially in system-default order.
     *   3. Return shortfall if stock is insufficient.
     *
     * Lot count is NOT minimised — order is preserved as-is.
     *
     * @param {Array<{lotNumber: string, lotId: string, availableQty: number}>} lots
     * @param {number} requiredQty
     * @returns {{success: boolean,
     *            lines: Array<{lotNumber: string, lotId: string, qty: number}>,
     *            shortfall: number}}
     */
    function selectLotsOriginal(lots, requiredQty) {
        log.debug('selectLotsOriginal', 'required=' + requiredQty + ' lotsAvail=' + lots.length);

        // Step 1 – exact single-lot match
        for (var i = 0; i < lots.length; i++) {
            if (lots[i].availableQty === requiredQty) {
                log.debug('selectLotsOriginal', 'Exact match on lot ' + lots[i].lotNumber);
                return {
                    success:   true,
                    lines:     [{ lotNumber: lots[i].lotNumber, lotId: lots[i].lotId, qty: requiredQty }],
                    shortfall: 0
                };
            }
        }

        // Step 2 – sequential draw (system order, no sort)
        var lines     = [];
        var remaining = requiredQty;

        for (var j = 0; j < lots.length && remaining > 0; j++) {
            var drawQty = Math.min(lots[j].availableQty, remaining);
            lines.push({ lotNumber: lots[j].lotNumber, lotId: lots[j].lotId, qty: drawQty });
            remaining -= drawQty;
        }

        if (remaining > 0) {
            log.error('selectLotsOriginal', 'Shortfall: required=' + requiredQty + ' short=' + remaining);
            return { success: false, lines: [], shortfall: remaining };
        }

        log.debug('selectLotsOriginal', 'Selected ' + lines.length + ' lot(s)');
        return { success: true, lines: lines, shortfall: 0 };
    }


    /* ------------------------------------------------------------------ */
    /*  Strategy 2 – Greedy Maximum (sort descending, fewest lots)        */
    /* ------------------------------------------------------------------ */

    /**
     * Select lot(s) using the greedy-maximum algorithm:
     *   1. Prefer a single exact-match lot.
     *   2. Sort remaining lots descending by availableQty.
     *   3. Draw sequentially (largest first → fewest lots consumed).
     *   4. Return shortfall if stock is insufficient.
     *
     * @param {Array<{lotNumber: string, lotId: string, availableQty: number}>} lots
     * @param {number} requiredQty
     * @returns {{success: boolean,
     *            lines: Array<{lotNumber: string, lotId: string, qty: number}>,
     *            shortfall: number}}
     */
    function selectLotsGreedyMax(lots, requiredQty) {
        log.debug('selectLotsGreedyMax', 'required=' + requiredQty + ' lotsAvail=' + lots.length);

        // Step 1 – exact single-lot match
        for (var i = 0; i < lots.length; i++) {
            if (lots[i].availableQty === requiredQty) {
                log.debug('selectLotsGreedyMax', 'Exact match on lot ' + lots[i].lotNumber);
                return {
                    success:   true,
                    lines:     [{ lotNumber: lots[i].lotNumber, lotId: lots[i].lotId, qty: requiredQty }],
                    shortfall: 0
                };
            }
        }

        // Step 2 – sort descending by available quantity (work on a copy to avoid side-effects)
        var sorted = lots.slice().sort(function (a, b) {
            return b.availableQty - a.availableQty;
        });

        // Step 3 – sequential draw from largest to smallest
        var lines     = [];
        var remaining = requiredQty;

        for (var j = 0; j < sorted.length && remaining > 0; j++) {
            var drawQty = Math.min(sorted[j].availableQty, remaining);
            lines.push({ lotNumber: sorted[j].lotNumber, lotId: sorted[j].lotId, qty: drawQty });
            remaining -= drawQty;
        }

        if (remaining > 0) {
            log.error('selectLotsGreedyMax', 'Shortfall: required=' + requiredQty + ' short=' + remaining);
            return { success: false, lines: [], shortfall: remaining };
        }

        log.debug('selectLotsGreedyMax', 'Selected ' + lines.length + ' lot(s)');
        return { success: true, lines: lines, shortfall: 0 };
    }


    /* ------------------------------------------------------------------ */
    /*  Strategy 3 – Optimised (exact → best-fit single → descending)     */
    /* ------------------------------------------------------------------ */

    /**
     * Select lot(s) using the optimised algorithm:
     *   1. Prefer a single exact-match lot.
     *   2. Prefer the smallest single lot that still covers the full qty
     *      (avoids tying up unnecessarily large lots).
     *   3. Sort remaining lots descending by availableQty and draw
     *      sequentially (fewest lots consumed).
     *   4. Return shortfall if stock is insufficient.
     *
     * This strategy minimises lot count AND preserves inventory flexibility
     * by not locking up a huge lot when a smaller one suffices.
     *
     * @param {Array<{lotNumber: string, lotId: string, availableQty: number}>} lots
     * @param {number} requiredQty
     * @returns {{success: boolean,
     *            lines: Array<{lotNumber: string, lotId: string, qty: number}>,
     *            shortfall: number}}
     */
    function selectLotsOptimised(lots, requiredQty) {
        log.debug('selectLotsOptimised', 'required=' + requiredQty + ' lotsAvail=' + lots.length);

        // Step 1 – exact single-lot match
        for (var i = 0; i < lots.length; i++) {
            if (lots[i].availableQty === requiredQty) {
                log.debug('selectLotsOptimised', 'Exact match on lot ' + lots[i].lotNumber);
                return {
                    success:   true,
                    lines:     [{ lotNumber: lots[i].lotNumber, lotId: lots[i].lotId, qty: requiredQty }],
                    shortfall: 0
                };
            }
        }

        // Step 2 – smallest sufficient single lot (best-fit)
        var bestFit = null;

        for (var k = 0; k < lots.length; k++) {
            if (lots[k].availableQty >= requiredQty) {
                if (!bestFit || lots[k].availableQty < bestFit.availableQty) {
                    bestFit = lots[k];
                }
            }
        }

        if (bestFit) {
            log.debug('selectLotsOptimised', 'Best-fit single lot ' + bestFit.lotNumber +
                    ' (avail=' + bestFit.availableQty + ')');
            return {
                success:   true,
                lines:     [{ lotNumber: bestFit.lotNumber, lotId: bestFit.lotId, qty: requiredQty }],
                shortfall: 0
            };
        }

        // Step 3 – sort descending by available quantity (work on a copy)
        var sorted = lots.slice().sort(function (a, b) {
            return b.availableQty - a.availableQty;
        });

        // Step 4 – sequential draw from largest to smallest
        var lines     = [];
        var remaining = requiredQty;

        for (var j = 0; j < sorted.length && remaining > 0; j++) {
            var drawQty = Math.min(sorted[j].availableQty, remaining);
            lines.push({ lotNumber: sorted[j].lotNumber, lotId: sorted[j].lotId, qty: drawQty });
            remaining -= drawQty;
        }

        if (remaining > 0) {
            log.error('selectLotsOptimised', 'Shortfall: required=' + requiredQty + ' short=' + remaining);
            return { success: false, lines: [], shortfall: remaining };
        }

        log.debug('selectLotsOptimised', 'Selected ' + lines.length + ' lot(s)');
        return { success: true, lines: lines, shortfall: 0 };
    }


    /* ------------------------------------------------------------------ *
     *  Strategy 4 – Lowest Bin First (ascending qty, tie → lotNumber)    *
     * ------------------------------------------------------------------ */
    /**
     * Select lot(s) using lowest-bin-first algorithm:
     *   1. Prefer a single exact-match lot.
     *   2. Sort ascending by availableQty.
     *   3. If tie, sort ascending by lotNumber (bin nomenclature).
     *   4. Draw sequentially (smallest first).
     *   5. Return shortfall if stock is insufficient.
     *
     * @param {Array<{lotNumber: string, lotId: string, availableQty: number}>} lots
     * @param {number} requiredQty
     * @returns {{success: boolean,
     *            lines: Array<{lotNumber: string, lotId: string, qty: number}>,
     *            shortfall: number}}
     */
    function selectLotsLowestBin(lots, requiredQty) {
        log.debug('selectLotsLowestBin', 'required=' + requiredQty + ' lotsAvail=' + lots.length);

        // Step 1 – exact single-lot match
        for (var i = 0; i < lots.length; i++) {
            if (lots[i].availableQty === requiredQty) {
                log.debug('selectLotsLowestBin', 'Exact match on lot ' + lots[i].lotNumber);
                return {
                    success:   true,
                    lines:     [{ lotNumber: lots[i].lotNumber, lotId: lots[i].lotId, qty: requiredQty }],
                    shortfall: 0
                };
            }
        }

        // Step 2 – sort ascending by availableQty, then ascending by lotNumber
        var sorted = lots.slice().sort(function (a, b) {
            if (a.availableQty !== b.availableQty) {
                return a.availableQty - b.availableQty; // smaller qty first
            }
            return a.lotNumber.localeCompare(b.lotNumber); // tie-breaker by bin nomenclature
        });

        // Step 3 – sequential draw from smallest to largest
        var lines     = [];
        var remaining = requiredQty;

        for (var j = 0; j < sorted.length && remaining > 0; j++) {
            var drawQty = Math.min(sorted[j].availableQty, remaining);
            lines.push({ lotNumber: sorted[j].lotNumber, lotId: sorted[j].lotId, qty: drawQty });
            remaining -= drawQty;
        }

        if (remaining > 0) {
            log.error('selectLotsLowestBin', 'Shortfall: required=' + requiredQty + ' short=' + remaining);
            return { success: false, lines: [], shortfall: remaining };
        }

        log.debug('selectLotsLowestBin', 'Selected ' + lines.length + ' lot(s)');
        return { success: true, lines: lines, shortfall: 0 };
    }

    function selectLots(lots, requiredQty) {
        return selectLotsLowestBin(lots,requiredQty);
    }

    /* ------------------------------------------------------------------ *
     *  INVENTORY DETAIL WRITER                                            *
     * ------------------------------------------------------------------ */

    /**
     * Write one or more lot lines into the Inventory Detail subrecord
     * of a transaction line.
     *
     * @param {Record} rec          - The transaction record
     * @param {string} sublistId    - e.g. 'item', 'component'
     * @param {number} lineIdx      - Line index on the sublist
     * @param {Array<{lotNumber: string, lotId: string, qty: number}>} lotLines
     * @param {object}  [options]
     * @param {string}  [options.binName]      - Bin to set (receiving only)
     * @param {string}  [options.invStatus]    - Inventory status to set
     */
    function writeInventoryDetail(rec, sublistId, lineIdx, lotLines, options) {
        options = options || {};
        log.debug('writeInventoryDetail',      lotLines     );    
        log.debug('writeInventoryDetail',      options     );    
        
        // ── Standard-mode access (works in beforeSubmit) ──
        var invDetail = rec.getSublistSubrecord({
            sublistId: sublistId,
            fieldId:   'inventorydetail',
            line:      lineIdx
        });

        if (!invDetail) {
            throw error.create({
                name:    'FV_LOT_NO_INVDETAIL',
                message: 'Cannot open Inventory Detail for ' + sublistId +
                         ' line ' + lineIdx
            });
        }

        // Clear existing assignment lines (auto-populated by NS in some cases)
        var existingCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
        for (var r = existingCount - 1; r >= 0; r--) {
            invDetail.removeLine({ sublistId: 'inventoryassignment', line: r });
        }

        // Write new lot lines (standard-mode: insertLine + setSublistValue)
        for (var k = 0; k < lotLines.length; k++) {
            invDetail.insertLine({ sublistId: 'inventoryassignment', line: k });

            invDetail.setSublistValue({
                sublistId: 'inventoryassignment',
                fieldId:   'issueinventorynumber',
                line:      k,
                value:     lotLines[k].lotId
            });

            // For receipts the field is 'receiptinventorynumber'
            // and we may be creating a NEW lot (not selecting existing)
            if (options.isReceipt) {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId:   'receiptinventorynumber',
                    line:      k,
                    value:     lotLines[k].lotNumber
                });
            }

            invDetail.setSublistValue({
                sublistId: 'inventoryassignment',
                fieldId:   'quantity',
                line:      k,
                value:     lotLines[k].qty
            });

            // Bin (FR-07, KBD-04)
            if (options.binName) {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId:   'binnumber',
                    line:      k,
                    value:     options.binName
                });
            }

            // Inventory Status
            if (options.invStatus) {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId:   'inventorystatus',
                    line:      k,
                    value:     options.invStatus
                });
            }
        }

        // No rec.commitLine needed in standard mode
        
        log.debug('writeInventoryDetail',
            sublistId + ' line ' + lineIdx + ': wrote ' + lotLines.length + ' lot line(s)');
    }

    /* ------------------------------------------------------------------ *
     *  INVENTORY DETAIL CLEARER                                           *
     * ------------------------------------------------------------------ */

    /**
     * Remove all existing inventory-assignment lines from the
     * Inventory Detail subrecord on a transaction line.
     *
     * Use this when a line's lot selection must be wiped (e.g. the
     * ordered quantity changed and stock can no longer cover it fully).
     *
     * @param {Record} rec        - The transaction record
     * @param {string} sublistId  - e.g. 'item', 'component'
     * @param {number} lineIdx    - Line index on the sublist
     */
    function clearInventoryDetail(rec, sublistId, lineIdx) {
        var invDetail = rec.getSublistSubrecord({
            sublistId: sublistId,
            fieldId:   'inventorydetail',
            line:      lineIdx
        });

        if (!invDetail) {
            // Nothing to clear — the line may not support inventory detail
            return;
        }

        var count = invDetail.getLineCount({ sublistId: 'inventoryassignment' });

        if (count <= 0) {
            return; // already empty
        }

        for (var r = count - 1; r >= 0; r--) {
            invDetail.removeLine({ sublistId: 'inventoryassignment', line: r });
        }

        log.debug('clearInventoryDetail',
            sublistId + ' line ' + lineIdx + ': cleared ' + count + ' assignment line(s)');
    }

    /* ------------------------------------------------------------------ *
     *  ITEM LOT-CONTROL CHECK                                             *
     * ------------------------------------------------------------------ */

    /**
     * Determine whether an item is lot-numbered.
     *
     * Checks both Inventory Item and Assembly Item record types so the
     * caller does not need to know the item's type in advance.
     *
     * @param {number|string} itemId
     * @returns {boolean}
     */
    function isLotNumbered(itemId) {
        var result = search.lookupFields({
            type:    'item',
            id:      itemId,
            columns: ['islotitem']
        });
        return result.islotitem === true || result.islotitem === 'T';
    }

    /* ------------------------------------------------------------------ *
     *  SERIALIZED ASSEMBLY CHECK                                          *
     * ------------------------------------------------------------------ */

    /**
     * Determine whether an item is a serialized assembly.
     *
     * Serialized assembly items are excluded from all auto-lot/serial
     * assignment logic — serial selection is entirely manual.
     *
     * NOTE: In NetSuite lot-numbered and serialized are mutually
     * exclusive, so a serialized item would also fail isLotNumbered().
     * This explicit check is provided for clarity, defensive coding,
     * and to produce a distinct log message that aids troubleshooting.
     *
     * @param {number|string} itemId
     * @returns {boolean}  true if the item is BOTH serialized AND an assembly
     */
    function isSerializedAssembly(itemId) {
        var result = search.lookupFields({
            type:    'item',
            id:      itemId,
            columns: ['isserialitem', 'type']
        });

        var isSerialized = (result.isserialitem === true || result.isserialitem === 'T');

        if (!isSerialized) {
            return false;
        }

        // 'type' returns as [{value: '...', text: '...'}] from lookupFields
        var itemType = '';
        if (result.type && result.type.length > 0) {
            itemType = result.type[0].value || '';
        }

        // NetSuite internal values for assembly: 'Assembly', 'assemblyitem'
        var isAssembly = (itemType === 'Assembly' || itemType === 'assemblyitem');

        log.debug('isSerializedAssembly',
            'item=' + itemId + ' serial=' + isSerialized +
            ' type=' + itemType + ' result=' + (isSerialized && isAssembly));

        return isSerialized && isAssembly;
    }

    /* ------------------------------------------------------------------ *
     *  PUBLIC API                                                         *
     * ------------------------------------------------------------------ */

    return {
        VENDOR_PART_NUM_RECORD: VENDOR_PART_NUM_RECORD,
        VPN_FIELDS:             VPN_FIELDS,
        DEFAULT_BIN:            DEFAULT_BIN,
        DEFAULT_INV_STATUS:     DEFAULT_INV_STATUS,
        
        lookupVendorCode:       lookupVendorCode,
        getAvailableLots:       getAvailableLots,
        selectLots:             selectLots,
      selectLotsGreedyMax :selectLotsGreedyMax ,
        writeInventoryDetail:   writeInventoryDetail,
        clearInventoryDetail:   clearInventoryDetail,
        isLotNumbered:          isLotNumbered,
        isSerializedAssembly:   isSerializedAssembly
      
    };
});
 
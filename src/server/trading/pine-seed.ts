// The first script in the Pine Vault: the owner's VWAP Double Break Suite, exactly as it was pasted in.
// It is stored raw (String.raw) so not one character changes, including the escaped quotes in its alert message.
// Its rules are locked: a new version is a new file, never an edit of this one (see vault.ts).

export const VWAP_DB_V1_0_0 = String.raw`//@version=6
indicator("VWAP Double Break Suite", shorttitle = "VWAP DB", overlay = true, max_labels_count = 500, max_boxes_count = 200)

// Boxes stay on the opening range. Stop is pulled in only if that range is > $325 on the micro.
// Target is 2R from the entry candle, not the far OR line. Checkmark when 2R hits. After a stop: one re-entry (DB2), then done.

groupVwap = "VWAPs"
showNyVwap        = input.bool(true, "Show NY VWAP", group = groupVwap)
showOvernightVwap = input.bool(true, "Show Overnight VWAP", group = groupVwap)

groupOr = "Opening Range"
showOrLines = input.bool(true, "Show Opening Range", group = groupOr)
orMinutes   = input.int(15, "Opening Range Minutes", minval = 5, maxval = 60, group = groupOr)
orColor     = input.color(color.new(#FFEA00, 0), "OR color", group = groupOr)
orWidth     = input.int(2, "OR width", minval = 1, maxval = 4, group = groupOr)

groupDb = "Double Break"
showDb        = input.bool(true, "Show DB tags", group = groupDb)
allowRecovery = input.bool(true, "One re-entry after a stop (DB2)", group = groupDb)
showDbBoxes   = input.bool(true, "Show SL / Target boxes", group = groupDb)
dbWindow      = input.session("1000-1200", "DB window (ET = 7-9 PT)", group = groupDb)

groupRisk = "Micro risk"
maxLossDollars = input.float(325.0, "Max loss $ (pull stop in if OR is wider)", minval = 50, step = 25, group = groupRisk)
stopBufferPts  = input.float(1.0, "Room past OR (points)", minval = 0, step = 0.25, group = groupRisk)

groupDash = "Dashboard"
showDashboard = input.bool(true, "Show ticker map", group = groupDash)
s1 = input.string("ES1!", "1", group = groupDash)
s2 = input.string("NQ1!", "2", group = groupDash)
s3 = input.string("GC1!", "3", group = groupDash)
s4 = input.string("CL1!", "4", group = groupDash)
s5 = input.string("BTC1!", "5", group = groupDash)
l1 = input.string("ES", "Label 1", group = groupDash)
l2 = input.string("NQ", "Label 2", group = groupDash)
l3 = input.string("GC", "Label 3", group = groupDash)
l4 = input.string("CL", "Label 4", group = groupDash)
l5 = input.string("BTC", "Label 5", group = groupDash)

tz = input.string("America/New_York", "Session Timezone")
nyVwapColor    = input.color(color.new(#2196F3, 0), "NY VWAP color")
overnightColor = input.color(color.new(#9C27B0, 0), "Overnight VWAP color")

microPv() =>
    string t = str.upper(syminfo.ticker)
    float pv = 5.0
    if str.contains(t, "MNQ") or str.contains(t, "NQ")
        pv := 2.0
    else if str.contains(t, "MES") or str.contains(t, "ES")
        pv := 5.0
    else if str.contains(t, "MGC") or str.contains(t, "GC")
        pv := 10.0
    else if str.contains(t, "MCL") or str.contains(t, "CL")
        pv := 100.0
    else if str.contains(t, "MBT") or str.contains(t, "BTC")
        pv := 0.10
    pv

computeSession() =>
    vwapSrc = hlc3
    bool inNy = not na(time(timeframe.period, "0930-1600", tz))
    bool inOn = not na(time(timeframe.period, "1800-0930", tz))
    bool inWindow = not na(time(timeframe.period, dbWindow, tz))
    bool isNyOpenBar = inNy and inNy[1] != true
    bool isOnOpenBar = inOn and inOn[1] != true
    nyH = hour(time, tz)
    nyM = minute(time, tz)
    int minsSinceOpen = (nyH - 9) * 60 + (nyM - 30)
    float pv = microPv()

    var float nySum = na
    var float nyVol = na
    var float nyVwap = na
    if isNyOpenBar
        nySum := vwapSrc * volume
        nyVol := volume
        nyVwap := vwapSrc
    else if inNy
        nySum := nz(nySum) + vwapSrc * volume
        nyVol := nz(nyVol) + volume
        nyVwap := nz(nyVol) > 0 ? nz(nySum) / nz(nyVol) : nz(nyVwap)

    var float onSum = na
    var float onVol = na
    var float onLive = na
    var float onFrozen = na
    if isOnOpenBar
        onSum := vwapSrc * volume
        onVol := volume
        onLive := vwapSrc
    else if inOn
        onSum := nz(onSum) + vwapSrc * volume
        onVol := nz(onVol) + volume
        onLive := nz(onVol) > 0 ? nz(onSum) / nz(onVol) : nz(onLive)
    if isNyOpenBar
        onFrozen := onLive
    float onVwap = inNy ? nz(onFrozen, onLive) : onLive

    var float orbH = na
    var float orbL = na
    var bool orbSet = false
    if isNyOpenBar
        orbH := high
        orbL := low
        orbSet := false
    else if inNy and not orbSet
        if minsSinceOpen >= 0 and minsSinceOpen < orMinutes
            orbH := math.max(nz(orbH), high)
            orbL := math.min(nz(orbL), low)
        else if minsSinceOpen >= orMinutes
            orbSet := true

    var string st = "IDLE"
    var bool longFired = false
    var bool shortFired = false
    var bool db2Used = false
    var int recoverDir = 0
    var int tradeDir = 0
    var float tradeEntry = na
    var float tradeSl = na
    var float tradeTp = na
    var int tradeBar = na
    var bool tradeIs2 = false
    var bool wonToday = false
    var bool dayDone = false

    bool above = not na(nyVwap) and close > nyVwap
    bool below = not na(nyVwap) and close < nyVwap
    bool crossUp = above and close[1] <= nz(nyVwap[1], nyVwap)
    bool crossDn = below and close[1] >= nz(nyVwap[1], nyVwap)

    if isNyOpenBar
        st := below ? "BROKE_DN" : above ? "BROKE_UP" : "IDLE"
        longFired := false
        shortFired := false
        db2Used := false
        recoverDir := 0
        tradeDir := 0
        tradeEntry := na
        tradeSl := na
        tradeTp := na
        tradeBar := na
        tradeIs2 := false
        wonToday := false
        dayDone := false
    else if inNy and st == "IDLE" and recoverDir == 0 and not dayDone
        if crossDn
            st := "BROKE_DN"
        if crossUp
            st := "BROKE_UP"

    bool canFire = showDb and inNy and inWindow and orbSet and tradeDir == 0 and not dayDone
    bool dbLong = canFire and st == "BROKE_DN" and crossUp and not longFired and barstate.isconfirmed
    bool dbShort = canFire and st == "BROKE_UP" and crossDn and not shortFired and barstate.isconfirmed
    bool db2Long = canFire and allowRecovery and recoverDir == 1 and not db2Used and crossUp and barstate.isconfirmed
    bool db2Short = canFire and allowRecovery and recoverDir == -1 and not db2Used and crossDn and barstate.isconfirmed

    float capPts = maxLossDollars / pv

    if dbLong or db2Long
        float slL = nz(orbL) - stopBufferPts
        if close - slL > capPts
            slL := close - capPts
        float riskL = math.max(close - slL, syminfo.mintick)
        tradeDir := 1
        tradeEntry := close
        tradeSl := slL
        tradeTp := close + riskL * 2.0
        tradeBar := bar_index
        tradeIs2 := db2Long
        st := "IDLE"
        recoverDir := 0
        if db2Long
            db2Used := true
        else
            longFired := true
    if dbShort or db2Short
        float slS = nz(orbH) + stopBufferPts
        if slS - close > capPts
            slS := close + capPts
        float riskS = math.max(slS - close, syminfo.mintick)
        tradeDir := -1
        tradeEntry := close
        tradeSl := slS
        tradeTp := close - riskS * 2.0
        tradeBar := bar_index
        tradeIs2 := db2Short
        st := "IDLE"
        recoverDir := 0
        if db2Short
            db2Used := true
        else
            shortFired := true

    bool dbWin = false
    bool dbLoss = false
    if tradeDir != 0 and bar_index > nz(tradeBar, bar_index)
        bool hitTp = tradeDir == 1 ? high >= tradeTp : low <= tradeTp
        bool hitSl = tradeDir == 1 ? low <= tradeSl : high >= tradeSl
        if hitTp
            dbWin := true
            wonToday := true
            dayDone := true
            recoverDir := 0
            tradeDir := 0
        else if hitSl
            dbLoss := true
            if allowRecovery and not tradeIs2 and not db2Used and inWindow
                recoverDir := tradeDir == 1 ? 1 : -1
            else
                dayDone := true
                recoverDir := 0
            tradeDir := 0

    int nyPos = above ? 1 : below ? -1 : 0
    int dbState = dayDone and wonToday ? 3 : dayDone ? 4 : recoverDir != 0 ? 5 : longFired or shortFired or db2Used ? 2 : st == "BROKE_UP" or st == "BROKE_DN" ? 1 : 0

    [nyVwap, onVwap, orbH, orbL, orbSet, dbLong, dbShort, db2Long, db2Short, dbWin, dbLoss, nyPos, dbState, tradeDir, tradeEntry, tradeSl, tradeTp, tradeBar, tradeIs2, recoverDir, dayDone, inNy, inWindow]

scanDash() =>
    [nyVwap, onVwap, orbH, orbL, orbSet, dbLong, dbShort, db2Long, db2Short, dbWin, dbLoss, nyPos, dbState, tradeDir, tradeEntry, tradeSl, tradeTp, tradeBar, tradeIs2, recoverDir, dayDone, inNy, inWindow] = computeSession()
    [nyPos, dbState]

nyTxt(pos) =>
    na(pos) ? "—" : pos > 0 ? "🟢" : pos < 0 ? "🔴" : "—"

dbTxt(st) =>
    na(st) ? "—" : st == 3 ? "✅" : st == 4 ? "⛔" : st == 5 ? "🔁" : st == 2 ? "🟢" : st == 1 ? "🟡" : "⚪"

[nyVwap, onVwap, orbH, orbL, orbSet, dbLong, dbShort, db2Long, db2Short, dbWin, dbLoss, nyPos, dbState, tradeDir, tradeEntry, tradeSl, tradeTp, tradeBar, tradeIs2, recoverDir, dayDone, inNySession, inWindow] = computeSession()

[d1Ny, d1Db] = request.security(s1, timeframe.period, scanDash(), ignore_invalid_symbol = true)
[d2Ny, d2Db] = request.security(s2, timeframe.period, scanDash(), ignore_invalid_symbol = true)
[d3Ny, d3Db] = request.security(s3, timeframe.period, scanDash(), ignore_invalid_symbol = true)
[d4Ny, d4Db] = request.security(s4, timeframe.period, scanDash(), ignore_invalid_symbol = true)
[d5Ny, d5Db] = request.security(s5, timeframe.period, scanDash(), ignore_invalid_symbol = true)

plot(showNyVwap and not na(nyVwap) ? nyVwap : na, title = "NY VWAP", color = nyVwapColor, linewidth = 3)
plot(showOvernightVwap and not na(onVwap) ? onVwap : na, title = "Overnight VWAP", color = overnightColor, linewidth = 2)
plot(showOrLines and orbSet ? orbH : na, title = "OR High", color = orColor, style = plot.style_linebr, linewidth = orWidth)
plot(showOrLines and orbSet ? orbL : na, title = "OR Low", color = orColor, style = plot.style_linebr, linewidth = orWidth)

bool isDbBar = dbLong or dbShort or db2Long or db2Short
barcolor(isDbBar ? color.white : na, title = "DB Candle Color")
plotcandle(isDbBar ? open : na, isDbBar ? high : na, isDbBar ? low : na, isDbBar ? close : na, title = "DB Candle", color = color.white, wickcolor = color.white, bordercolor = color.white)

if dbLong
    label.new(bar_index, low, "DB", style = label.style_label_up, color = color.new(#43A047, 0), textcolor = color.white, size = size.large)
if dbShort
    label.new(bar_index, high, "DB", style = label.style_label_down, color = color.new(#E53935, 0), textcolor = color.white, size = size.large)
if db2Long
    label.new(bar_index, low, "DB2", style = label.style_label_up, color = color.new(#F9A825, 0), textcolor = color.black, size = size.large)
if db2Short
    label.new(bar_index, high, "DB2", style = label.style_label_down, color = color.new(#F9A825, 0), textcolor = color.black, size = size.large)
if dbWin
    label.new(bar_index, high, "✔", style = label.style_label_down, color = color.new(#43A047, 0), textcolor = color.white, size = size.large)
if dbLoss and recoverDir != 0
    label.new(bar_index, low, "re-entry", style = label.style_label_up, color = color.new(#F9A825, 0), textcolor = color.black, size = size.small)
if dbLoss and recoverDir == 0
    label.new(bar_index, low, "done", style = label.style_label_up, color = color.new(#616161, 0), textcolor = color.white, size = size.small)

plotshape(recoverDir != 0 and not isDbBar, title = "Re-entry armed", style = shape.diamond, location = location.belowbar, color = color.new(#F9A825, 30), size = size.tiny)

var box slBox = na
var box tpBox = na
if showDbBoxes and isDbBar and not na(tradeEntry) and not na(tradeSl) and not na(tradeTp)
    slBox := box.new(bar_index, math.max(tradeEntry, tradeSl), bar_index + 4, math.min(tradeEntry, tradeSl), bgcolor = color.new(color.red, 80), border_color = color.new(color.red, 50), extend = extend.none)
    tpBox := box.new(bar_index, math.max(tradeEntry, tradeTp), bar_index + 4, math.min(tradeEntry, tradeTp), bgcolor = color.new(color.green, 80), border_color = color.new(color.green, 50), extend = extend.none)
if showDbBoxes and tradeDir != 0
    int rightBar = math.min(bar_index, nz(tradeBar) + 24)
    if not na(slBox)
        box.set_right(slBox, rightBar)
    if not na(tpBox)
        box.set_right(tpBox, rightBar)

jsonMsg(side, kind) =>
    "{\"ticker\":\"" + syminfo.ticker + "\",\"price\":" + str.tostring(close) + ",\"ny_vwap\":" + str.tostring(nz(nyVwap)) + ",\"stop\":" + str.tostring(nz(tradeSl)) + ",\"target\":" + str.tostring(nz(tradeTp)) + ",\"event_type\":\"" + kind + "\",\"side\":\"" + side + "\"}"

if barstate.isconfirmed
    if dbLong
        alert(jsonMsg("LONG", "NY_VWAP_SECOND_BREAK"), alert.freq_once_per_bar_close)
    if dbShort
        alert(jsonMsg("SHORT", "NY_VWAP_SECOND_BREAK"), alert.freq_once_per_bar_close)
    if db2Long
        alert(jsonMsg("LONG", "NY_VWAP_RECOVERY"), alert.freq_once_per_bar_close)
    if db2Short
        alert(jsonMsg("SHORT", "NY_VWAP_RECOVERY"), alert.freq_once_per_bar_close)

dashBg = color.new(#1a1a1a, 10)
var table dash = table.new(position.bottom_right, 6, 3, bgcolor = dashBg, frame_color = color.new(#616161, 20), frame_width = 1)
if barstate.islast and showDashboard
    table.cell(dash, 0, 0, "Ticker", text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 0, 1, "NY VWAP", text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 0, 2, "Double Break", text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 1, 0, l1, text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 2, 0, l2, text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 3, 0, l3, text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 4, 0, l4, text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 5, 0, l5, text_color = color.white, text_size = size.small, bgcolor = dashBg)
    table.cell(dash, 1, 1, nyTxt(d1Ny), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 2, 1, nyTxt(d2Ny), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 3, 1, nyTxt(d3Ny), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 4, 1, nyTxt(d4Ny), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 5, 1, nyTxt(d5Ny), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 1, 2, dbTxt(d1Db), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 2, 2, dbTxt(d2Db), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 3, 2, dbTxt(d3Db), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 4, 2, dbTxt(d4Db), text_size = size.normal, bgcolor = dashBg)
    table.cell(dash, 5, 2, dbTxt(d5Db), text_size = size.normal, bgcolor = dashBg)
else if barstate.islast
    table.clear(dash, 0, 0, 5, 2)
`;

/**
 * v1.0.1: the same script with one addition, a "ver" field in the alert message, so every live alert says
 * which version sent it. Nothing about the signals, stops or targets changes.
 */
export const VWAP_DB_V1_0_1 = VWAP_DB_V1_0_0.replace('//@version=6\n', '//@version=6\n// VWAP Double Break Suite v1.0.1: v1.0.0 plus a "ver" field in the alert message (signals unchanged).\n').replace('"{\\"ticker\\":\\""', '"{\\"ver\\":\\"1.0.1\\",\\"ticker\\":\\""');

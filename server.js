-- // =============================================
-- // HOPPER HÍBRIDO FULL - Railway (Jobs) + Vultr (Report)
-- // =============================================

local RAILWAY_URL = "https://jobid-scanner-production.up.railway.app"
local VULTR_IP = "http://65.21.231.113:3000"
local VULTR_API_KEY = "SALAH2026"

local PLACE_ID = 109983668079237
local MIN_REPORT_VALUE = 10000000
local LIST_MIN_VALUE = 10000000
local EMBED_COLOR = 0xFF69B4
local EMBED_BRAND = "Flash Notifier - Dev BY SALAH ⚡"

local WEBHOOKS = {
	["10_100"] = "",
	["100_400"] = "",
	["400_1b"] = "",
	["1b_plus"] = "",
}

local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local LocalPlayer = Players.LocalPlayer

local requestFunc = syn and syn.request or http_request or http and http.request or request

local lastAttemptedJobId = nil
local failedJobIds = {}

if not requestFunc then
	warn("[FATAL] No hay funcion HTTP disponible en este executor")
	return
end

-- // REDUCIR CALIDAD
pcall(function() settings().Rendering.QualityLevel = Enum.QualityLevel.Level01 end)
pcall(function() setfpscap(4) end)
pcall(function() game:GetService("ReplicatedFirst"):RemoveDefaultLoadingScreen() end)

-- // ESPERAR CARGA
repeat task.wait() until game:IsLoaded()
repeat task.wait() until Players.LocalPlayer
LocalPlayer = Players.LocalPlayer
task.wait(5)

-- // ANTI IDLE
do
	local vu = game:GetService("VirtualUser")
	local lastAntiIdle = 0
	LocalPlayer.Idled:Connect(function()
		local now = tick()
		if now - lastAntiIdle < 60 then return end
		lastAntiIdle = now
		pcall(function()
			vu:CaptureController()
			vu:ClickButton2(Vector2.new())
		end)
	end)
end

-- // UTILIDADES
local function formatNum(n)
	if n >= 1e9 then return string.format("%.2fB", n / 1e9)
	elseif n >= 1e6 then return string.format("%.2fM", n / 1e6)
	elseif n >= 1e3 then return string.format("%.2fK", n / 1e3)
	else return tostring(math.floor(n)) end
end

local function shouldScan(value) return value >= MIN_REPORT_VALUE end

local function getTier(v)
	if v >= 1e9 then return "1b"
	elseif v >= 400e6 then return "400m"
	elseif v >= 100e6 then return "100m"
	elseif v >= 10e6 then return "10m" end
	return "low"
end

-- ====================== ENDPOINTS ======================
-- ✅ MODIFIE pour TON Railway
local function getJobUrl()
	return RAILWAY_URL .. "/jobs?placeId=" .. PLACE_ID .. "&key=" .. HttpService:UrlEncode(VULTR_API_KEY)
end

local function reportDataUrl()
	return string.format("%s/report-data?key=%s", VULTR_IP, HttpService:UrlEncode(VULTR_API_KEY))
end
-- =======================================================

-- // HOP - Railway
local function hop()
	while true do
		print("[HOP] Solicitando nuevo servidor de Railway...")
		local ok, response = pcall(function()
			return requestFunc({
				Url = getJobUrl(),
				Method = "GET",
				Headers = { ["username"] = LocalPlayer.Name },
			})
		end)

		local sc = ok and response and response.StatusCode
		local body = ok and response and type(response.Body) == "string" and response.Body or ""

		if ok and sc == 200 and body and body ~= "" then
			local targetJobId = body:match("^%s*([%w%-]+)%s*$")
			if targetJobId and targetJobId ~= game.JobId and not failedJobIds[targetJobId] then
				lastAttemptedJobId = targetJobId
				print("[HOP] Teleport a JobID:", targetJobId:sub(1, 12), "...")
				TeleportService:TeleportToPlaceInstance(PLACE_ID, targetJobId, LocalPlayer)
				return
			end
		elseif sc == 503 then
			print("[HOP] Pool sin servidores (503), reintentando...")
		else
			warn("[HOP] Error StatusCode=", tostring(sc))
		end
		task.wait(3)
	end
end

TeleportService.TeleportInitFailed:Connect(function(player, result, errorMessage)
	if player == LocalPlayer then
		if lastAttemptedJobId then failedJobIds[lastAttemptedJobId] = true end
		warn("[HOP] Teleport falló, reintentando...")
		task.wait(1.5)
		hop()
	end
end)

-- // SAFE REQUIRE
local function safeRequire(module)
	local get_thread_identity = getthreadidentity or getidentity or function() return 2 end
	local set_thread_identity = setthreadidentity or setidentity or function() end
	local current = get_thread_identity()
	set_thread_identity(2)
	local success, result = pcall(require, module)
	set_thread_identity(current)
	return success and result or require(module)
end

local function waitForPath(parent, ...)
	local current = parent
	for _, name in ipairs({ ... }) do
		current = current:WaitForChild(name, 10)
		if not current then return nil end
	end
	return current
end

do
	local Sync = require(game.ReplicatedStorage:WaitForChild("Packages"):WaitForChild("Synchronizer"))
	local patched = 0

	for name, fn in pairs(Sync) do
		if typeof(fn) ~= "function" then continue end
		if isexecutorclosure(fn) then continue end

		local ok, ups = pcall(debug.getupvalues, fn)
		if not ok then continue end

		for idx, val in pairs(ups) do
			if typeof(val) == "function" and not isexecutorclosure(val) then
				local ok2, innerUps = pcall(debug.getupvalues, val)
				if ok2 then
					local hasBoolean = false
					for _, v in pairs(innerUps) do
						if typeof(v) == "boolean" then
							hasBoolean = true
							break
						end
					end
					if hasBoolean then
						debug.setupvalue(fn, idx, newcclosure(function() end))
						patched += 1
					end
				end
			end
		end
	end
end

-- // CARGAR MÓDULOS
local sync, animalsData, animalsShared, numberUtils
for i = 1, 5 do
	local ok, err = pcall(function()
		sync = safeRequire(waitForPath(game.ReplicatedStorage, "Packages", "Synchronizer"))
		animalsData = safeRequire(waitForPath(game.ReplicatedStorage, "Datas", "Animals"))
		animalsShared = safeRequire(waitForPath(game.ReplicatedStorage, "Shared", "Animals"))
		numberUtils = safeRequire(waitForPath(game.ReplicatedStorage, "Utils", "NumberUtils"))
	end)
	if ok and sync and animalsData and animalsShared and numberUtils then
		print("[INIT] Módulos cargados correctamente")
		break
	end
	task.wait(2)
end

if not (sync and animalsData and animalsShared and numberUtils) then
	warn("[FATAL] No se pudieron cargar los módulos")
	hop()
	return
end

-- // DEDUP
local loggedBrainrots = {}

local function hasBeenLogged(jobId, name, gen)
	return loggedBrainrots[jobId .. ":" .. name .. ":" .. gen] == true
end

local function markAsLogged(jobId, name, gen)
	loggedBrainrots[jobId .. ":" .. name .. ":" .. gen] = true
end

-- // CHECKS
local function isFusing(animalData)
	if animalData.Machine and animalData.Machine.Type == "Fuse" and animalData.Machine.Active then
		return true
	end
	return false
end

local function isInDuel(animalData)
	local data = animalData.Data or animalData
	if animalData.Machine and type(animalData.Machine) == "table" then
		local mType = animalData.Machine.Type
		if type(mType) == "string" and mType:lower():find("duel") then return true end
	end
	if data and data.Machine and type(data.Machine) == "table" then
		local mType = data.Machine.Type
		if type(mType) == "string" and mType:lower():find("duel") then return true end
	end
	if animalData.InDuel or animalData.inDuel or animalData.in_duel then return true end
	return false
end

-- // SCAN CARPET (FULL)
local function scanCarpet(seen, currentJobId)
	local results = {}
	for _, instance in ipairs(Workspace:GetChildren()) do
		if instance.ClassName ~= "Model" then continue end
		local name = instance:GetAttribute("Index")
		if not name or not animalsData[name] then continue end

		local mutation = instance:GetAttribute("Mutation")
		if type(mutation) ~= "string" or mutation == "" then mutation = nil end

		local traitsTable = nil
		local traitsList = {}
		local traitsRaw = instance:GetAttribute("Traits")
		if traitsRaw and type(traitsRaw) == "string" then
			local ok, decoded = pcall(function() return HttpService:JSONDecode(traitsRaw) end)
			if ok and type(decoded) == "table" then
				traitsTable = {}
				for _, trait in ipairs(decoded) do
					if type(trait) == "string" then
						table.insert(traitsTable, trait)
						table.insert(traitsList, trait)
					end
				end
				if #traitsTable == 0 then traitsTable = nil end
			end
		end

		if instance:GetAttribute("Fusing") == true then continue end

		local okGen, genValue = pcall(function()
			return animalsShared:GetGeneration(name, mutation, traitsTable, nil)
		end)
		if not okGen or type(genValue) ~= "number" or not shouldScan(genValue) then continue end

		local genText = "$" .. numberUtils:ToString(genValue) .. "/s"
		local key = "carpet:" .. name .. ":" .. genText
		if seen[key] or hasBeenLogged(currentJobId, name, genText) then continue end
		seen[key] = true

		table.insert(results, {
			tier = getTier(genValue),
			name = name,
			money = genText,
			numeric = genValue,
			mutation = mutation,
			traits = #traitsList > 0 and traitsList or nil,
			traitCount = traitsTable and #traitsTable or 0,
			isFusing = false,
			inDuel = false,
			isCarpet = true,
			isContext = false,
		})
	end
	return results
end

-- // SCAN PLOTS (FULL)
local function scanPlots(seen, currentJobId)
	local results = {}
	local plots = Workspace:FindFirstChild("Plots")
	if not plots then return results end

	for _, plot in ipairs(plots:GetChildren()) do
		local okPot, pot = pcall(function() return sync:Get(plot.Name) end)
		if not okPot or not pot then continue end

		local okList, list = pcall(function() return pot:Get("AnimalList") end)
		if not okList or type(list) ~= "table" then continue end

		for _, animalData in pairs(list) do
			if type(animalData) ~= "table" or isFusing(animalData) then continue end

			local name = animalData.Index
			if not name or not animalsData[name] then continue end

			local data = animalData.Data or animalData
			local mutation = data.Mutation
			if type(mutation) ~= "string" or mutation == "" then mutation = nil end

			local traitsTable = nil
			local traitsList = {}
			if type(data.Traits) == "table" then
				traitsTable = {}
				for _, trait in ipairs(data.Traits) do
					if type(trait) == "string" then
						table.insert(traitsTable, trait)
						table.insert(traitsList, trait)
					end
				end
				if #traitsTable == 0 then traitsTable = nil end
			end

			local okGen, genValue = pcall(function()
				return animalsShared:GetGeneration(name, mutation, traitsTable, nil)
			end)
			if not okGen or type(genValue) ~= "number" or not shouldScan(genValue) then continue end

			local genText = "$" .. numberUtils:ToString(genValue) .. "/s"
			local key = "plot:" .. name .. ":" .. genText
			if seen[key] or hasBeenLogged(currentJobId, name, genText) then continue end
			seen[key] = true

			table.insert(results, {
				tier = getTier(genValue),
				name = name,
				money = genText,
				numeric = genValue,
				mutation = mutation,
				traits = #traitsList > 0 and traitsList or nil,
				traitCount = traitsTable and #traitsTable or 0,
				isFusing = false,
				inDuel = isInDuel(animalData),
				isCarpet = false,
				isContext = false,
			})
		end
	end
	return results
end

local function scanAll()
	local seen = {}
	local currentJobId = game.JobId
	local plotResults = scanPlots(seen, currentJobId)
	local carpetResults = scanCarpet(seen, currentJobId)
	local allResults = {}

	for _, v in ipairs(plotResults) do table.insert(allResults, v) end
	for _, v in ipairs(carpetResults) do table.insert(allResults, v) end

	table.sort(allResults, function(a, b) return a.numeric > b.numeric end)
	return allResults
end

-- // REPORTE A VULTR
local function reportEverything(bestItem, allItems)
	local jid = game.JobId
	local apiItems = {}
	for _, item in ipairs(allItems) do
		table.insert(apiItems, {
			name = item.name,
			money = item.money,
			numeric = item.numeric,
			tier = item.tier,
			source = item.isCarpet and "carpet" or "plot",
			inDuel = item.inDuel == true,
			mutation = item.mutation,
			traits = item.traits,
			traitCount = item.traitCount or 0,
		})
	end

	-- Enviar a Vultr
	pcall(function()
		requestFunc({
			Url = reportDataUrl(),
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({
				jobId = jid,
				name = bestItem.name,
				money = bestItem.money,
				numeric = bestItem.numeric,
				source = bestItem.isCarpet and "carpet" or "plot",
				inDuel = bestItem.inDuel == true,
				isContext = bestItem.isContext == true,
				players = #Players:GetPlayers(),
				brainrots = apiItems
			})
		})
		print("[REPORT] Enviado correctamente a Vultr")
	end)

	-- Webhooks Discord
	local hook = nil
	if bestItem.numeric >= 1e9 then hook = WEBHOOKS["1b_plus"]
	elseif bestItem.numeric >= 400e6 then hook = WEBHOOKS["400_1b"]
	elseif bestItem.numeric >= 100e6 then hook = WEBHOOKS["100_400"]
	elseif bestItem.numeric >= 10e6 then hook = WEBHOOKS["10_100"] end

	if hook and hook ~= "" then
		local listLines = {}
		for i = 1, math.min(#allItems, 25) do
			local item = allItems[i]
			if item.numeric >= LIST_MIN_VALUE then
				local tags = "[" .. (item.isCarpet and "CARPET" or "PLOT") .. "]"
				if item.inDuel then tags = tags .. "[DUEL]" end
				table.insert(listLines, string.format("%s %s (%s)", tags, item.name, formatNum(item.numeric)))
			end
		end

		local payload = {
			embeds = {{
				title = bestItem.name .. " (" .. formatNum(bestItem.numeric) .. ")",
				description = EMBED_BRAND,
				color = EMBED_COLOR,
				fields = {
					{ name = "Job ID", value = "`"..jid.."`", inline = false },
					{ name = "Players", value = #Players:GetPlayers().."/8", inline = true },
				}
			}}
		}
		pcall(function()
			requestFunc({
				Url = hook,
				Method = "POST",
				Headers = {["Content-Type"] = "application/json"},
				Body = HttpService:JSONEncode(payload)
			})
		end)
	end

	for _, item in ipairs(allItems) do
		markAsLogged(jid, item.name, item.money)
	end
end

-- // MAIN
local function main()
	print("[SCANNER] Escaneando servidor...")
	local results = scanAll()
	if #results > 0 then
		print("[SCANNER] Encontrados:", #results, "| Mejor:", results[1].name, results[1].money)
		reportEverything(results[1], results)
		task.wait(1)
	else
		print("[SCANNER] Sin brainrots en este servidor")
	end
	hop()
end

main()

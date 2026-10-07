local RunService = game:GetService("RunService")
assert(not RunService:IsRunning(), "Stop the playtest before running this update.")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local ServerStorage = game:GetService("ServerStorage")
local modules = assert(ReplicatedStorage:FindFirstChild("Modules"), "ReplicatedStorage.Modules is missing")
local services = assert(ServerScriptService:FindFirstChild("Services"), "ServerScriptService.Services is missing")
local targets = {
    HatDefinitions = assert(modules:FindFirstChild("HatDefinitions"), "HatDefinitions is missing"),
    HatService = assert(services:FindFirstChild("HatService"), "HatService is missing"),
    ServerMain = assert(ServerScriptService:FindFirstChild("ServerMain", true), "ServerMain is missing")
}
local patches = {
	HatDefinitions = {
		{[====[			or definition.ItemType == "Hair"
			or definition.ItemType == "Face"]====], [====[			or definition.ItemType == "Hair"
			or definition.ItemType == "Head"
			or definition.ItemType == "Face"]====]},
		{[====[assert(not definition.Headless or (definition.ItemType == "Hat" and]====], [====[assert(not definition.Headless or ((definition.ItemType == "Hat" or definition.ItemType == "Head") and]====]},
		{[====[Headless cosmetics require the Roblox Headless Head asset and ItemType Hat.]====], [====[Headless cosmetics require the Roblox Headless Head asset.]====]},
		{[====[	definition.AnnouncementVersion = tostring(raw.AnnouncementVersion or "")]====], [====[	definition.AnnouncementVersion = tostring(raw.AnnouncementVersion or "")
	definition.PublisherAnnouncement = raw.PublisherAnnouncement == "worker" and "worker" or ""]====]},
	},
	HatService = {
		{[====[	if definition
		and definition.ItemType ~= "Hat"
		and definition.ItemType ~= "Hair"
		and definition.ItemType ~= "Tool" then]====], [====[	if definition
		and definition.ItemType ~= "Hat"
		and definition.ItemType ~= "Hair"
		and definition.ItemType ~= "Head"
		and definition.ItemType ~= "Tool" then]====]},
		{[====[		elseif definition.ItemType == "Hat" or definition.ItemType == "Hair" or definition.ItemType == "Tool" then]====], [====[		elseif definition.ItemType == "Hat" or definition.ItemType == "Hair" or definition.ItemType == "Head" or definition.ItemType == "Tool" then]====]},
		{[====[function HatService.SetCreatorSaleHook(callback)]====], [====[function HatService.CreateStaticHeadAccessory(definition)
	local description = Instance.new("HumanoidDescription")
	description.Head = math.floor(tonumber(definition.AssetId) or 0)
	description.HeadScale = 1
	pcall(function() description.UseAvatarSettings = false; description.MoodAnimation = 0 end)
	local model, handle, accessory
	local ok, result = pcall(function()
		model = Players:CreateHumanoidModelFromDescriptionAsync(description, Enum.HumanoidRigType.R15)
		local source = model:FindFirstChild("Head")
		assert(source and source:IsA("BasePart"), "Roblox did not provide a head model")
		handle = source:Clone()
		if handle:IsA("MeshPart") then handle.TextureID = "" end
		for _, object in ipairs(handle:GetDescendants()) do
			if object:IsA("SpecialMesh") then object.TextureId = "" end
			if object:IsA("LuaSourceContainer") or object:IsA("FaceControls") or object:IsA("Animator")
				or object:IsA("AnimationController") or object:IsA("JointInstance") or object:IsA("Constraint")
				or object:IsA("Attachment") or object:IsA("WrapTarget") or object:IsA("Decal") or object:IsA("Texture") or object:IsA("SurfaceAppearance") then
				object:Destroy()
			end
		end
		handle.Material = Enum.Material.SmoothPlastic
		handle.MaterialVariant = ""
		handle.Reflectance = 0
		handle.Name = "Handle"
		handle.CFrame = CFrame.new()
		handle.Anchored = false
		handle.CanCollide = false
		handle.CanTouch = false
		handle.CanQuery = false
		handle.Massless = true
		local defaultFace = HatDefinitions.Get(HatDefinitions.DEFAULT_FACE_NAME or "Smile")
		local face = Instance.new("Decal")
		face.Name = "face"
		face.Face = Enum.NormalId.Front
		face.Texture = defaultFace and defaultFace.Texture ~= "" and defaultFace.Texture or "rbxasset://textures/face.png"
		face.Transparency = 0
		face.Parent = handle
		local attachment = Instance.new("Attachment")
		attachment.Name = "HatAttachment"
		attachment.CFrame = CFrame.new(0, 0.6, 0)
		attachment.Parent = handle
		accessory = Instance.new("Accessory")
		accessory.Name = definition.Name
		accessory:SetAttribute("ReminisceStaticHead", true)
		accessory:SetAttribute("ReminisceClassicHeadFace", true)
		accessory:SetAttribute("ReminisceHeadSmileVersion", 2)
		accessory:SetAttribute("ItemType", "Head")
		accessory:SetAttribute("AssetId", definition.AssetId)
		accessory:SetAttribute("RobloxAssetId", definition.AssetId)
		handle.Parent = accessory
		return accessory
	end)
	description:Destroy()
	if model then model:Destroy() end
	if not ok then
		if accessory then accessory:Destroy() elseif handle then handle:Destroy() end
		error(result)
	end
	return result
end

function HatService.SetCreatorSaleHook(callback)]====]},
		{[====[accessory:SetAttribute("ItemType", "Hat")]====], [====[accessory:SetAttribute("ItemType", definition.ItemType)]====]},
		{[====[	elseif definition.ItemType == "Hat" or definition.ItemType == "Hair" then]====], [====[	elseif definition.ItemType == "Head" then
		return asset:IsA("Accessory") and asset:GetAttribute("ReminisceStaticHead") == true
			and tonumber(asset:GetAttribute("AssetId")) == definition.AssetId
	elseif definition.ItemType == "Hat" or definition.ItemType == "Hair" then]====]},
		{[====[		if definition.ItemType == "Face" then
			local texture = normalizePhysicalContent(definition.Texture)]====], [====[		if definition.ItemType == "Head" then
			repaired = HatService.CreateStaticHeadAccessory(definition)
			repaired.Parent = folder
			return
		end

		if definition.ItemType == "Face" then
			local texture = normalizePhysicalContent(definition.Texture)]====]},
		{[====[	elseif definition.ItemType == "Hat"
		or definition.ItemType == "Hair"
		or definition.ItemType == "Tool" then]====], [====[	elseif definition.ItemType == "Hat"
		or definition.ItemType == "Hair"
		or definition.ItemType == "Head"
		or definition.ItemType == "Tool" then]====]},
		{[====[	if definition.ItemType == "Tool" then
		return "Tool"
	elseif definition.ItemType == "Hair" then]====], [====[	if definition.ItemType == "Head" or definition.Headless == true then
		return "BodyHead"
	elseif definition.ItemType == "Tool" then
		return "Tool"
	elseif definition.ItemType == "Hair" then]====]},
		{[====[local EQUIPMENT_CAPS = {
	Head = 4]====], [====[local EQUIPMENT_CAPS = {
	BodyHead = 1,
	Head = 4]====]},
		{[====[	local wearing = false
	for _, child in ipairs(character:GetChildren()) do
		if child:IsA("Accessory") then
			local definition = HatDefinitions.Get(child.Name)
			if child:GetAttribute("ReminisceHeadless") == true or (definition and definition.Headless == true) then
				wearing = true
				break
			end
		end
	end
	local head = character:FindFirstChild("Head")]====], [====[	local wearing, headless = false, false
	local head = character:FindFirstChild("Head")
	for _, child in ipairs(character:GetChildren()) do
		if child:IsA("Accessory") then
			local definition = HatDefinitions.Get(child.Name)
			if child:GetAttribute("ReminisceHeadless") == true or (definition and definition.Headless == true) then
				wearing, headless = true, true
			elseif child:GetAttribute("ReminisceStaticHead") == true then
				wearing = true
				local handle = child:FindFirstChild("Handle")
				if head and handle and handle:IsA("BasePart") then
					handle.Color = head.Color
					if child:GetAttribute("ReminisceClassicHeadFace") == true then
						local originalFace = head:FindFirstChildWhichIsA("Decal")
						local face = handle:FindFirstChildWhichIsA("Decal")
						if originalFace then
							if not face then face = Instance.new("Decal"); face.Name = "face"; face.Parent = handle end
							face.Face = Enum.NormalId.Front
							face.Texture = originalFace.Texture
							face.Transparency = 0
						end
					end
				end
			end
		end
	end]====]},
		{[====[character:SetAttribute("ReminisceHeadlessActive", wearing)]====], [====[character:SetAttribute("ReminisceHeadlessActive", headless)
	character:SetAttribute("ReminisceStaticHeadActive", wearing and not headless)]====]},
		{[====[		table.insert(connections, character.DescendantAdded:Connect(function(child)]====], [====[		if head then table.insert(connections, head:GetPropertyChangedSignal("Color"):Connect(refresh)) end
		table.insert(connections, character.DescendantAdded:Connect(function(child)]====]},
		{[====[			and tonumber(asset:GetAttribute("AssetId")) == definition.AssetId
	elseif definition.ItemType == "Hat"]====], [====[			and asset:GetAttribute("ReminisceHeadSmileVersion") == 2
			and tonumber(asset:GetAttribute("AssetId")) == definition.AssetId
	elseif definition.ItemType == "Hat"]====]},
		{[====[			and definition.CreatorTShirt ~= true
			and not isEventItem]====], [====[			and definition.CreatorTShirt ~= true
			and definition.PublisherAnnouncement ~= "worker"
			and not isEventItem]====]},
	},
	ServerMain = {
		{[====[old.schema == 1 and old.signature == signature then return nil end]====], [====[old.schema == 1 and old.signature == signature and type(old.types) == "table" and old.types.Head == true and old.announcements == "worker" then return nil end]====]},
		{[====[types = {Hat = true, Hair = true, Face = true, Tool = true, BodyPackage = true, TShirt = true}]====], [====[types = {Hat = true, Hair = true, Head = true, Face = true, Tool = true, BodyPackage = true, TShirt = true}]====]},
		{[====[placeId = game.PlaceId, updatedAt = os.time()}]====], [====[placeId = game.PlaceId, placeVersion = game.PlaceVersion, publisherVersion = "3.5.0", announcements = "worker", updatedAt = os.time()}]====]},
	},
}
local headAppearancePatches = {
	{[====[function HatService.CreateStaticHeadAccessory(definition)
	local description = Instance.new("HumanoidDescription")
	description.Head = math.floor(tonumber(definition.AssetId) or 0)
	description.HeadScale = 1
	pcall(function() description.UseAvatarSettings = false; description.MoodAnimation = 0 end)
	local model, handle, accessory
	local ok, result = pcall(function()
		model = Players:CreateHumanoidModelFromDescriptionAsync(description, Enum.HumanoidRigType.R15)
		local source = model:FindFirstChild("Head")
		assert(source and source:IsA("BasePart"), "Roblox did not provide a head model")
		handle = source:Clone()
		if handle:IsA("MeshPart") then handle.TextureID = "" end
		for _, object in ipairs(handle:GetDescendants()) do
			if object:IsA("SpecialMesh") then object.TextureId = "" end
			if object:IsA("LuaSourceContainer") or object:IsA("FaceControls") or object:IsA("Animator")
				or object:IsA("AnimationController") or object:IsA("JointInstance") or object:IsA("Constraint")
				or object:IsA("Attachment") or object:IsA("WrapTarget") or object:IsA("Decal") or object:IsA("Texture") or object:IsA("SurfaceAppearance") then
				object:Destroy()
			end
		end
		handle.Name = "Handle"
		handle.CFrame = CFrame.new()
		handle.Anchored = false
		handle.CanCollide = false
		handle.CanTouch = false
		handle.CanQuery = false
		handle.Massless = true
		local defaultFace = HatDefinitions.Get(HatDefinitions.DEFAULT_FACE_NAME or "Smile")
		local face = Instance.new("Decal")
		face.Name = "face"
		face.Face = Enum.NormalId.Front
		face.Texture = defaultFace and defaultFace.Texture ~= "" and defaultFace.Texture or "rbxasset://textures/face.png"
		face.Transparency = 0
		face.Parent = handle
		local attachment = Instance.new("Attachment")
		attachment.Name = "HatAttachment"
		attachment.CFrame = CFrame.new(0, 0.6, 0)
		attachment.Parent = handle
		accessory = Instance.new("Accessory")
		accessory.Name = definition.Name
		accessory:SetAttribute("ReminisceStaticHead", true)
		accessory:SetAttribute("ReminisceClassicHeadFace", true)
		accessory:SetAttribute("ReminisceHeadSmileVersion", 1)
		accessory:SetAttribute("ItemType", "Head")
		accessory:SetAttribute("AssetId", definition.AssetId)
		accessory:SetAttribute("RobloxAssetId", definition.AssetId)
		handle.Parent = accessory
		return accessory
	end)
	description:Destroy()
	if model then model:Destroy() end
	if not ok then
		if accessory then accessory:Destroy() elseif handle then handle:Destroy() end
		error(result)
	end
	return result
end

]====], [====[function HatService.CreateStaticHeadAccessory(definition)
	local description = Instance.new("HumanoidDescription")
	description.Head = math.floor(tonumber(definition.AssetId) or 0)
	description.HeadScale = 1
	pcall(function() description.UseAvatarSettings = false; description.MoodAnimation = 0 end)
	local model, handle, accessory
	local ok, result = pcall(function()
		model = Players:CreateHumanoidModelFromDescriptionAsync(description, Enum.HumanoidRigType.R15)
		local source = model:FindFirstChild("Head")
		assert(source and source:IsA("BasePart"), "Roblox did not provide a head model")
		handle = source:Clone()
		if handle:IsA("MeshPart") then handle.TextureID = "" end
		for _, object in ipairs(handle:GetDescendants()) do
			if object:IsA("SpecialMesh") then object.TextureId = "" end
			if object:IsA("LuaSourceContainer") or object:IsA("FaceControls") or object:IsA("Animator")
				or object:IsA("AnimationController") or object:IsA("JointInstance") or object:IsA("Constraint")
				or object:IsA("Attachment") or object:IsA("WrapTarget") or object:IsA("Decal") or object:IsA("Texture") or object:IsA("SurfaceAppearance") then
				object:Destroy()
			end
		end
		handle.Material = Enum.Material.SmoothPlastic
		handle.MaterialVariant = ""
		handle.Reflectance = 0
		handle.Name = "Handle"
		handle.CFrame = CFrame.new()
		handle.Anchored = false
		handle.CanCollide = false
		handle.CanTouch = false
		handle.CanQuery = false
		handle.Massless = true
		local defaultFace = HatDefinitions.Get(HatDefinitions.DEFAULT_FACE_NAME or "Smile")
		local face = Instance.new("Decal")
		face.Name = "face"
		face.Face = Enum.NormalId.Front
		face.Texture = defaultFace and defaultFace.Texture ~= "" and defaultFace.Texture or "rbxasset://textures/face.png"
		face.Transparency = 0
		face.Parent = handle
		local attachment = Instance.new("Attachment")
		attachment.Name = "HatAttachment"
		attachment.CFrame = CFrame.new(0, 0.6, 0)
		attachment.Parent = handle
		accessory = Instance.new("Accessory")
		accessory.Name = definition.Name
		accessory:SetAttribute("ReminisceStaticHead", true)
		accessory:SetAttribute("ReminisceClassicHeadFace", true)
		accessory:SetAttribute("ReminisceHeadSmileVersion", 2)
		accessory:SetAttribute("ItemType", "Head")
		accessory:SetAttribute("AssetId", definition.AssetId)
		accessory:SetAttribute("RobloxAssetId", definition.AssetId)
		handle.Parent = accessory
		return accessory
	end)
	description:Destroy()
	if model then model:Destroy() end
	if not ok then
		if accessory then accessory:Destroy() elseif handle then handle:Destroy() end
		error(result)
	end
	return result
end

]====]},
	{[====[			and asset:GetAttribute("ReminisceHeadSmileVersion") == 1]====], [====[			and asset:GetAttribute("ReminisceHeadSmileVersion") == 2]====]},
}
local plan = {}
local signatures = {
    HatDefinitions = 'definition.PublisherAnnouncement = raw.PublisherAnnouncement == "worker"',
    HatService = 'accessory:SetAttribute("ReminisceHeadSmileVersion", 2)',
    ServerMain = 'publisherVersion = "3.5.0", announcements = "worker"'
}
for _, name in ipairs({"HatDefinitions", "HatService", "ServerMain"}) do
    local target = targets[name]
    assert(target:IsA("LuaSourceContainer"), name .. " is not a script")
    if not string.find(target.Source, signatures[name], 1, true) then
        local source = target.Source
        local changes = patches[name]
        if name == "HatService" and string.find(source, headAppearancePatches[1][1], 1, true) then changes = headAppearancePatches end
        for _, change in ipairs(changes) do
            local first, last = string.find(source, change[1], 1, true)
            assert(first and not string.find(source, change[1], last + 1, true), name .. " has an unexpected source version. No scripts were changed; use the updated game files instead.")
            source = string.sub(source, 1, first - 1) .. change[2] .. string.sub(source, last + 1)
        end
        table.insert(plan, {target = target, source = source, previous = target.Source})
    end
end
if #plan == 0 then print("Publishing update 3.5.0 is already installed.") return end
local backup = Instance.new("Folder")
backup.Name = "ReminiscePublishingBackup_" .. tostring(os.time())
for _, change in ipairs(plan) do
    local copy = change.target:Clone()
    if copy:IsA("Script") or copy:IsA("LocalScript") then copy.Enabled = false end
    copy.Parent = backup
end
backup.Parent = ServerStorage
local ok, err = pcall(function()
    for _, change in ipairs(plan) do change.target.Source = change.source end
end)
if not ok then
    for _, change in ipairs(plan) do pcall(function() change.target.Source = change.previous end) end
    error("Update failed; original scripts restored. " .. tostring(err))
end
print("Publishing update 3.5.0 installed. Publish this existing place and start a new server. Backup: " .. backup:GetFullName())

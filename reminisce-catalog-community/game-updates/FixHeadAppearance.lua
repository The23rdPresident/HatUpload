local RunService = game:GetService("RunService")
assert(not RunService:IsRunning(), "Stop the playtest before running this fix.")
local services = assert(game:GetService("ServerScriptService"):FindFirstChild("Services"), "Services is missing")
local target = assert(services:FindFirstChild("HatService"), "HatService is missing")
assert(target:IsA("ModuleScript"), "HatService is not a ModuleScript")
local changes = {
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
local previous = target.Source
local source = previous
for _, change in ipairs(changes) do
    local first, last = string.find(source, change[1], 1, true)
    local installed, installedLast = string.find(source, change[2], 1, true)
    if first then
        assert(not installed and not string.find(source, change[1], last + 1, true), "HatService has an unexpected source version. No changes were made.")
        source = string.sub(source, 1, first - 1) .. change[2] .. string.sub(source, last + 1)
    else
        assert(installed and not string.find(source, change[2], installedLast + 1, true), "Install the 3.5.0 game update first, or use the updated game files. No changes were made.")
    end
end
if source == previous then print("Head appearance fix is already installed.") return end
local backup = target:Clone()
backup.Name = "HatService_HeadAppearanceBackup_" .. tostring(os.time())
backup.Parent = game:GetService("ServerStorage")
local ok, err = pcall(function() target.Source = source end)
if not ok then
    pcall(function() target.Source = previous end)
    error("Head appearance fix failed; original source restored. " .. tostring(err))
end
print("Head appearance fix installed. Publish this existing place and restart its servers.")

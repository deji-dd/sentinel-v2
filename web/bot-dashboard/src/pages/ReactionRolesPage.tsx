import {
	ArrowLeft,
	Check,
	Hash,
	Loader2,
	Pencil,
	Plus,
	ShieldCheck,
	Smile,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import NotInitializedView from "../components/NotInitializedView";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";
import { useRouter } from "../router";

interface Channel {
	id: string;
	name: string;
	type: number;
}

interface Role {
	id: string;
	name: string;
	color: number;
}

interface ReactionRoleMapping {
	id: string;
	messageId: string;
	emoji: string;
	roleId: string;
	description: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface ReactionRoleMessage {
	id: string;
	guildId: string;
	title: string;
	channelId: string;
	messageId: string | null;
	requiredRoleId: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	mappings: ReactionRoleMapping[];
}

interface MappingFormPayload {
	id?: string;
	emoji: string;
	roleId: string;
	description: string;
}

interface ReactionRolesPageProps {
	guildId: string;
}

function roleColor(color: number): string {
	if (!color) return "#64748b";
	return `#${color.toString(16).padStart(6, "0")}`;
}

const EMOJI_PRESETS = ["📌", "🔔", "⚔️", "🛡️", "🎯", "📢", "🎁"];

export default function ReactionRolesPage({ guildId }: ReactionRolesPageProps) {
	const { toast } = useToast();
	const { navigate } = useRouter();

	const [loading, setLoading] = useState(true);
	const [isInitialized, setIsInitialized] = useState(true);
	const [isEnabled, setIsEnabled] = useState(true);

	const [channels, setChannels] = useState<Channel[]>([]);
	const [roles, setRoles] = useState<Role[]>([]);
	const [messages, setMessages] = useState<ReactionRoleMessage[]>([]);

	const [searchQuery, setSearchQuery] = useState("");
	const [selectedChannelFilter, setSelectedChannelFilter] =
		useState<string>("all");

	// Modal State
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Form Fields
	const [title, setTitle] = useState("");
	const [channelId, setChannelId] = useState("");
	const [requiredRoleId, setRequiredRoleId] = useState<string>("");
	const [mappings, setMappings] = useState<MappingFormPayload[]>([
		{ emoji: "📌", roleId: "", description: "" },
	]);

	const fetchData = useCallback(async () => {
		setLoading(true);
		try {
			const guildRoute = api.api.v1.guilds({ guildId });
			if (!guildRoute) return;

			const [configRes, channelsRes, rolesRes, rrRes] = await Promise.all([
				guildRoute.config.get(),
				guildRoute.channels.get(),
				guildRoute.roles.get(),
				guildRoute["reaction-roles"].get(),
			]);

			if (configRes.data) {
				const data = configRes.data;
				if (!data.initialized || !data.config) {
					setIsInitialized(false);
					setLoading(false);
					return;
				}

				setIsInitialized(true);
				setIsEnabled(true);
			}

			if (channelsRes.data && "channels" in channelsRes.data) {
				const textChannels = (channelsRes.data.channels as Channel[]).filter(
					(c) => c.type === 0 || c.type === 5,
				);
				setChannels(textChannels);
			}

			if (rolesRes.data && "roles" in rolesRes.data) {
				setRoles(rolesRes.data.roles as Role[]);
			}

			if (rrRes.data && "messages" in rrRes.data) {
				setMessages(rrRes.data.messages as ReactionRoleMessage[]);
			}
		} catch {
			toast("Failed to load reaction roles configuration.", "error");
		} finally {
			setLoading(false);
		}
	}, [guildId, toast]);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	// Open modal for creating new message
	const handleOpenCreateModal = () => {
		setEditingMessageId(null);
		setTitle("");
		setChannelId(channels[0]?.id ?? "");
		setRequiredRoleId("");
		setMappings([
			{
				emoji: "📌",
				roleId: "",
				description: "General updates & announcements",
			},
			{ emoji: "🔔", roleId: "", description: "Event notifications" },
		]);
		setIsModalOpen(true);
		window.scrollTo({ top: 0, behavior: "smooth" });
	};

	// Open modal for editing existing message
	const handleOpenEditModal = (msg: ReactionRoleMessage) => {
		setEditingMessageId(msg.id);
		setTitle(msg.title);
		setChannelId(msg.channelId);
		setRequiredRoleId(msg.requiredRoleId ?? "");
		setMappings(
			msg.mappings.length > 0
				? msg.mappings.map((m) => ({
						id: m.id,
						emoji: m.emoji,
						roleId: m.roleId,
						description: m.description ?? "",
					}))
				: [{ emoji: "📌", roleId: "", description: "" }],
		);
		setIsModalOpen(true);
		window.scrollTo({ top: 0, behavior: "smooth" });
	};

	const handleCloseModal = () => {
		setIsModalOpen(false);
		setEditingMessageId(null);
	};

	// Add mapping row
	const handleAddMappingRow = () => {
		const nextPreset =
			EMOJI_PRESETS[mappings.length % EMOJI_PRESETS.length] ?? "📌";
		setMappings((prev) => [
			...prev,
			{ emoji: nextPreset, roleId: "", description: "" },
		]);
	};

	// Remove mapping row
	const handleRemoveMappingRow = (index: number) => {
		if (mappings.length <= 1) {
			toast(
				"Reaction menus must have at least one emoji role binding.",
				"error",
			);
			return;
		}
		setMappings((prev) => prev.filter((_, i) => i !== index));
	};

	// Update mapping row field
	const handleUpdateMapping = (
		index: number,
		field: keyof MappingFormPayload,
		value: string,
	) => {
		setMappings((prev) =>
			prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
		);
	};

	// Submit modal form
	const handleSubmitForm = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!title.trim()) {
			toast("Please enter a title for the reaction role menu.", "error");
			return;
		}
		if (!channelId) {
			toast(
				"Please select a target channel to post the reaction menu.",
				"error",
			);
			return;
		}

		// Validate mappings
		const validMappings = mappings.filter(
			(m) => m.emoji.trim() && m.roleId.trim(),
		);
		if (validMappings.length === 0) {
			toast("Please assign a Discord role for at least one emoji.", "error");
			return;
		}

		// Check duplicate emojis
		const emojis = validMappings.map((m) => m.emoji.trim());
		if (new Set(emojis).size !== emojis.length) {
			toast("Each emoji in a reaction menu must be unique.", "error");
			return;
		}

		const payload = {
			title: title.trim(),
			channelId,
			requiredRoleId: requiredRoleId || null,
			mappings: validMappings.map((m) => ({
				emoji: m.emoji.trim(),
				roleId: m.roleId.trim(),
				description: m.description?.trim() || null,
			})),
		};

		setIsSubmitting(true);
		try {
			let savedMessage: ReactionRoleMessage | null = null;

			// Try direct API endpoint
			const endpoint = editingMessageId
				? `/api/v1/guilds/${guildId}/reaction-roles/${editingMessageId}`
				: `/api/v1/guilds/${guildId}/reaction-roles`;

			const res = await fetch(endpoint, {
				method: editingMessageId ? "PUT" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (res.ok) {
				const resData = (await res.json()) as {
					success?: boolean;
					message?: ReactionRoleMessage;
				};
				if (resData.success && resData.message) {
					savedMessage = resData.message;
				}
			}

			if (savedMessage) {
				toast(
					editingMessageId
						? "Reaction role menu updated successfully!"
						: "Reaction role menu created successfully!",
					"success",
				);
				const updatedMsg = savedMessage;
				if (editingMessageId) {
					setMessages((prev) =>
						prev.map((m) => (m.id === editingMessageId ? updatedMsg : m)),
					);
				} else {
					setMessages((prev) => [updatedMsg, ...prev]);
				}
				handleCloseModal();
			} else {
				toast(
					editingMessageId
						? "Failed to update reaction role menu."
						: "Failed to create reaction role menu.",
					"error",
				);
			}
		} catch {
			toast("An unexpected error occurred while saving.", "error");
		} finally {
			setIsSubmitting(false);
		}
	};

	// Delete message
	const handleDelete = async (msg: ReactionRoleMessage) => {
		setIsDeleting(true);
		try {
			const res = await fetch(
				`/api/v1/guilds/${guildId}/reaction-roles/${msg.id}`,
				{ method: "DELETE" },
			);
			if (res.ok) {
				toast(`Deleted "${msg.title}" reaction menu.`, "success");
				setMessages((prev) => prev.filter((m) => m.id !== msg.id));
				setDeleteConfirmId(null);
			} else {
				toast("Failed to delete reaction role menu.", "error");
			}
		} catch {
			toast("Failed to delete reaction role menu.", "error");
		} finally {
			setIsDeleting(false);
		}
	};

	// Filtering
	const filteredMessages = messages.filter((msg) => {
		const matchesSearch =
			msg.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
			msg.mappings.some((m) => {
				const r = roles.find((role) => role.id === m.roleId);
				return (
					m.emoji.includes(searchQuery) ||
					(r?.name.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
				);
			});

		const matchesChannel =
			selectedChannelFilter === "all" ||
			msg.channelId === selectedChannelFilter;

		return matchesSearch && matchesChannel;
	});

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3 py-4 border-b border-border/60">
					<Loader2 className="size-5 animate-spin text-primary" />
					<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
						Loading Reaction Roles Configuration...
					</span>
				</div>
				{[1, 2].map((i) => (
					<Card
						key={`skeleton-${i}`}
						className="p-6 border-border/60 bg-card/60"
					>
						<Skeleton className="h-6 w-1/3 mb-4 rounded-lg" />
						<Skeleton className="h-10 w-full rounded-xl mb-2" />
						<Skeleton className="h-4 w-1/2 rounded-lg" />
					</Card>
				))}
			</div>
		);
	}

	if (!isInitialized) {
		return <NotInitializedView guildId={guildId} />;
	}

	if (!isEnabled) {
		return (
			<div className="space-y-8">
				<div className="pb-6 border-b border-border/60">
					<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
						Reaction Roles
					</h1>
					<p className="text-muted-foreground text-sm mt-1">
						Module is currently disabled for this server.
					</p>
				</div>

				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-8 sm:p-12 text-center flex flex-col items-center gap-4">
					<div className="size-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shadow-xs">
						<Smile className="size-7" />
					</div>
					<div className="space-y-1">
						<CardTitle className="text-xl font-bold tracking-tight text-foreground">
							Module Disabled
						</CardTitle>
						<p className="text-muted-foreground text-xs sm:text-sm max-w-md leading-relaxed">
							The Reaction Roles module is turned off for this server. Contact a
							Sentinel administrator to enable this module.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => navigate(`/guilds/${guildId}`)}
						className="mt-2 text-xs font-semibold rounded-xl gap-2 cursor-pointer"
					>
						<ArrowLeft className="size-4" data-icon="inline-start" />
						Back to Settings
					</Button>
				</Card>
			</div>
		);
	}

	return (
		<div className="space-y-8 pb-20">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-border/60">
				<div>
					<h1 className="text-3xl font-extrabold tracking-tight text-foreground">
						Reaction Roles
					</h1>
					<p className="text-muted-foreground text-sm mt-1">
						Configure interactive reaction role menus for automated role
						self-assignment.
					</p>
				</div>
				<Button
					type="button"
					onClick={handleOpenCreateModal}
					className="h-10 px-5 rounded-xl text-xs font-semibold gap-2 shrink-0 cursor-pointer shadow-lg shadow-primary/20"
				>
					<Plus className="size-4" data-icon="inline-start" />
					New Reaction Menu
				</Button>
			</div>

			{/* Control Bar: Search & Channel Filter */}
			<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-4">
				<div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
					<div className="flex flex-1 flex-col sm:flex-row items-center gap-3">
						{/* Search Input */}
						<div className="relative w-full sm:w-72">
							<Input
								type="text"
								placeholder="Search menus or roles..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="w-full pr-5 h-10 rounded-xl bg-background border-input text-foreground text-sm"
							/>
							{searchQuery && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => setSearchQuery("")}
									className="absolute right-0 top-1/2 -translate-y-1/2 size-7 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
									title="Clear search"
								>
									<X className="size-3.5" />
								</Button>
							)}
						</div>

						{/* Channel Filter Dropdown */}
						<div className="w-full sm:w-56">
							<Select
								value={selectedChannelFilter}
								onValueChange={(val) => setSelectedChannelFilter(val)}
							>
								<SelectTrigger className="h-10 rounded-xl bg-background border-input text-foreground text-sm">
									<SelectValue placeholder="All Target Channels" />
								</SelectTrigger>
								<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground">
									<SelectGroup>
										<SelectItem value="all">All Target Channels</SelectItem>
										{channels.map((ch) => (
											<SelectItem key={ch.id} value={ch.id}>
												#{ch.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>
			</Card>

			{/* CREATE / EDIT REACTION ROLE INLINE FORM CARD */}
			{isModalOpen && (
				<Card className="border-border/80 rounded-2xl shadow-2xl bg-card/95 backdrop-blur-md overflow-hidden animate-in fade-in slide-in-from-top-4 duration-200">
					{/* Header */}
					<div className="flex items-center justify-between px-6 py-5 border-b border-border bg-muted/20">
						<div>
							<h2 className="text-xl font-extrabold text-foreground tracking-tight">
								{editingMessageId
									? "Edit Reaction Role Menu"
									: "Create New Reaction Role Menu"}
							</h2>
							<p className="text-xs text-muted-foreground leading-relaxed">
								Configure channel, required access, and emoji-to-role mappings.
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={handleCloseModal}
							className="size-8 rounded-xl text-muted-foreground hover:text-foreground cursor-pointer"
						>
							<X className="size-4" />
						</Button>
					</div>

					{/* Form Content: Clean Single Column Editor */}
					<form onSubmit={handleSubmitForm}>
						<div className="p-6 lg:p-8 space-y-6">
							{/* Title Input */}
							<div className="space-y-2">
								<label
									htmlFor="rr-title"
									className="block text-xs font-mono uppercase tracking-wider font-semibold text-muted-foreground"
								>
									Message Title <span className="text-destructive">*</span>
								</label>
								<Input
									id="rr-title"
									type="text"
									placeholder="e.g. Roles & Notifications"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									required
									className="w-full h-10 rounded-xl bg-background border-input text-foreground text-sm font-medium"
								/>
								<p className="text-[11px] text-muted-foreground">
									This will be displayed as the main title header in the Discord
									embed.
								</p>
							</div>

							{/* Channel Selection */}
							<div className="space-y-2">
								<label
									htmlFor="rr-channel"
									className="block text-xs font-mono uppercase tracking-wider font-semibold text-muted-foreground"
								>
									Target Channel <span className="text-destructive">*</span>
								</label>
								<Select
									value={channelId}
									onValueChange={(val) => setChannelId(val)}
								>
									<SelectTrigger
										id="rr-channel"
										className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-medium"
									>
										<SelectValue placeholder="-- Select Target Channel --" />
									</SelectTrigger>
									<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
										<SelectGroup>
											{channels.length === 0 ? (
												<SelectItem value="" disabled>
													No text channels found
												</SelectItem>
											) : (
												channels.map((ch) => (
													<SelectItem key={ch.id} value={ch.id}>
														#{ch.name}
													</SelectItem>
												))
											)}
										</SelectGroup>
									</SelectContent>
								</Select>
								<p className="text-[11px] text-muted-foreground">
									The Discord channel where Sentinel will post and maintain this
									reaction menu.
								</p>
							</div>

							{/* Optional Required Role */}
							<div className="space-y-2 p-4 sm:p-5 rounded-2xl bg-muted/30 border border-border space-y-2.5">
								<label
									htmlFor="rr-required-role"
									className="block text-xs font-mono uppercase tracking-wider font-semibold text-muted-foreground"
								>
									Optional Required Access Role
								</label>
								<Select
									value={requiredRoleId}
									onValueChange={(val) =>
										setRequiredRoleId(val === "none" ? "" : val)
									}
								>
									<SelectTrigger
										id="rr-required-role"
										className="h-10 rounded-xl bg-background border-input text-foreground text-sm font-medium"
									>
										<SelectValue placeholder="-- None (Allow Any Member) --" />
									</SelectTrigger>
									<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
										<SelectGroup>
											<SelectItem value="none">
												-- None (Allow Any Member) --
											</SelectItem>
											{roles.map((r) => (
												<SelectItem key={r.id} value={r.id}>
													@{r.name}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
								<p className="text-[11px] text-muted-foreground leading-relaxed">
									If set, members must have this role for the bot to grant or
									remove roles when reacting.
								</p>
							</div>

							{/* Emoji & Role Mappings Section */}
							<div className="space-y-4 pt-2 border-t border-border/60">
								<div className="flex items-center justify-between">
									<div>
										<h4 className="text-sm font-extrabold text-foreground tracking-tight">
											Emoji Role Bindings
										</h4>
										<p className="text-xs text-muted-foreground">
											Map each emoji reaction to a Discord server role.
										</p>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={handleAddMappingRow}
										className="h-9 px-3 rounded-xl text-xs font-semibold gap-1.5 cursor-pointer"
									>
										<Plus className="size-3.5" data-icon="inline-start" />
										Add Binding
									</Button>
								</div>

								{/* Preset Emoji Picker Ribbon */}
								<div className="p-4 sm:p-5 rounded-2xl bg-muted/30 border border-border space-y-3 shadow-xs">
									<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider block font-bold">
										Quick Emoji Presets
									</span>
									<div className="flex flex-wrap gap-2 pt-1">
										{EMOJI_PRESETS.map((emoji) => (
											<button
												key={emoji}
												type="button"
												onClick={() => {
													const emptyIdx = mappings.findIndex((m) => !m.emoji);
													if (emptyIdx !== -1) {
														handleUpdateMapping(emptyIdx, "emoji", emoji);
													} else {
														setMappings((prev) => [
															...prev,
															{ emoji, roleId: "", description: "" },
														]);
													}
												}}
												className="size-9 rounded-xl bg-background hover:bg-muted border border-border text-lg flex items-center justify-center transition-all cursor-pointer hover:scale-110 active:scale-95 shadow-2xs"
												title={`Insert ${emoji}`}
											>
												{emoji}
											</button>
										))}
									</div>
								</div>

								{/* Mapping Rows */}
								<div className="space-y-3">
									{mappings.map((m, idx) => (
										<div
											key={m.id || idx}
											className="p-4 sm:p-5 rounded-2xl bg-muted/30 border border-border space-y-3 relative shadow-xs"
										>
											<div className="flex items-center justify-between gap-3">
												<span className="text-[11px] font-mono text-muted-foreground font-semibold">
													Binding #{idx + 1}
												</span>
												{mappings.length > 1 && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => handleRemoveMappingRow(idx)}
														className="size-7 rounded-lg text-muted-foreground hover:text-destructive cursor-pointer"
														title="Remove row"
													>
														<Trash2 className="size-3.5" />
													</Button>
												)}
											</div>

											<div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
												{/* Emoji Input */}
												<div className="sm:col-span-3">
													<label
														htmlFor={`rr-emoji-${idx}`}
														className="block text-[10px] font-mono text-muted-foreground uppercase mb-1 font-semibold"
													>
														Emoji
													</label>
													<Input
														id={`rr-emoji-${idx}`}
														type="text"
														placeholder="📌"
														value={m.emoji}
														onChange={(e) =>
															handleUpdateMapping(idx, "emoji", e.target.value)
														}
														className="w-full text-center h-10 rounded-xl bg-background border-input text-lg font-sans"
													/>
												</div>

												{/* Target Role Dropdown */}
												<div className="sm:col-span-9">
													<label
														htmlFor={`rr-role-${idx}`}
														className="block text-[10px] font-mono text-muted-foreground uppercase mb-1 font-semibold"
													>
														Target Role{" "}
														<span className="text-destructive">*</span>
													</label>
													<Select
														value={m.roleId}
														onValueChange={(val) =>
															handleUpdateMapping(idx, "roleId", val)
														}
													>
														<SelectTrigger
															id={`rr-role-${idx}`}
															className="h-10 rounded-xl bg-background border-input text-foreground text-xs font-medium"
														>
															<SelectValue placeholder="-- Select Role --" />
														</SelectTrigger>
														<SelectContent className="rounded-xl border-border bg-popover text-popover-foreground max-h-60">
															<SelectGroup>
																{roles.map((r) => (
																	<SelectItem key={r.id} value={r.id}>
																		@{r.name}
																	</SelectItem>
																))}
															</SelectGroup>
														</SelectContent>
													</Select>
												</div>
											</div>

											{/* Description Input */}
											<div>
												<label
													htmlFor={`rr-desc-${idx}`}
													className="block text-[10px] font-mono text-muted-foreground uppercase mb-1 font-semibold"
												>
													Label / Description (Optional)
												</label>
												<Input
													id={`rr-desc-${idx}`}
													type="text"
													placeholder="e.g. Receive faction raid notifications"
													value={m.description || ""}
													onChange={(e) =>
														handleUpdateMapping(
															idx,
															"description",
															e.target.value,
														)
													}
													className="w-full h-9 rounded-xl bg-background/60 border-input text-xs text-foreground placeholder:text-muted-foreground"
												/>
											</div>
										</div>
									))}
								</div>
							</div>
						</div>

						{/* Form Actions Footer */}
						<div className="px-6 py-4 border-t border-border bg-muted/20 flex flex-row items-center justify-end gap-3">
							<Button
								type="button"
								variant="outline"
								onClick={handleCloseModal}
								className="h-10 px-4 rounded-xl text-xs font-semibold cursor-pointer"
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={isSubmitting}
								className="h-10 px-5 rounded-xl text-xs font-semibold gap-2 cursor-pointer shadow-lg shadow-primary/20"
							>
								{isSubmitting ? (
									<>
										<Loader2
											className="size-4 animate-spin"
											data-icon="inline-start"
										/>
										Saving...
									</>
								) : (
									<>
										<Check className="size-4" data-icon="inline-start" />
										{editingMessageId ? "Save Changes" : "Create Reaction Menu"}
									</>
								)}
							</Button>
						</div>
					</form>
				</Card>
			)}

			{/* Reaction Role Message Cards Grid */}
			{filteredMessages.length === 0 ? (
				<Card className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-12 text-center flex flex-col items-center gap-4">
					<div className="size-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shadow-xs">
						<Smile className="size-7" />
					</div>
					<div className="space-y-1">
						<CardTitle className="text-xl font-bold tracking-tight text-foreground">
							No Reaction Role Menus Found
						</CardTitle>
						<p className="text-muted-foreground text-xs sm:text-sm max-w-md leading-relaxed">
							{searchQuery || selectedChannelFilter !== "all"
								? "No reaction role menus match your search criteria. Try adjusting your search query or filter."
								: "Get started by creating your first interactive reaction role menu for members to self-assign roles."}
						</p>
					</div>
					{!searchQuery && selectedChannelFilter === "all" && (
						<Button
							type="button"
							onClick={handleOpenCreateModal}
							className="mt-2 h-10 px-5 rounded-xl text-xs font-semibold gap-2 cursor-pointer shadow-lg shadow-primary/20"
						>
							<Plus className="size-4" data-icon="inline-start" />
							Create Reaction Role Menu
						</Button>
					)}
				</Card>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					{filteredMessages.map((msg) => {
						const channel = channels.find((c) => c.id === msg.channelId);
						const reqRole = roles.find((r) => r.id === msg.requiredRoleId);

						return (
							<Card
								key={msg.id}
								className="border-border/80 shadow-xl bg-card/90 backdrop-blur-md rounded-2xl p-6 flex flex-col justify-between hover:border-border transition-all space-y-5"
							>
								<div className="space-y-4">
									{/* Card Top Banner */}
									<div className="flex items-start justify-between gap-4 pb-4 border-b border-border/40">
										<div className="space-y-1.5 min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<Badge
													variant="outline"
													className="border-border bg-background text-foreground font-mono text-[11px] font-semibold gap-1 rounded-full px-2.5 py-0.5"
												>
													<Hash className="size-3 text-muted-foreground" />
													{channel ? channel.name : msg.channelId}
												</Badge>
												{msg.requiredRoleId && (
													<Badge
														variant="secondary"
														className="border border-border font-mono text-[11px] font-semibold gap-1 rounded-full px-2.5 py-0.5"
														title={`Requires role: @${reqRole ? reqRole.name : msg.requiredRoleId}`}
													>
														<ShieldCheck className="size-3 text-amber-500" />
														Gated: @
														{reqRole ? reqRole.name : msg.requiredRoleId}
													</Badge>
												)}
											</div>
											<h3 className="text-xl font-extrabold text-foreground tracking-tight leading-snug truncate">
												{msg.title}
											</h3>
										</div>

										{/* Action Buttons */}
										<div className="flex items-center gap-1.5 shrink-0">
											<Button
												type="button"
												variant="outline"
												size="icon"
												onClick={() => handleOpenEditModal(msg)}
												className="size-9 rounded-xl border-border bg-background hover:bg-muted text-foreground transition-all cursor-pointer"
												title="Edit Menu"
											>
												<Pencil className="size-4" />
											</Button>
											{deleteConfirmId === msg.id ? (
												<div className="flex items-center gap-1 bg-destructive/10 border border-destructive/30 rounded-xl p-1 animate-in fade-in zoom-in duration-150">
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => handleDelete(msg)}
														disabled={isDeleting}
														className="h-7 px-2.5 rounded-lg text-xs font-semibold gap-1 cursor-pointer"
													>
														{isDeleting ? (
															<Loader2 className="size-3 animate-spin" />
														) : (
															"Confirm"
														)}
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => setDeleteConfirmId(null)}
														className="size-7 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
													>
														<X className="size-3.5" />
													</Button>
												</div>
											) : (
												<Button
													type="button"
													variant="outline"
													size="icon"
													onClick={() => setDeleteConfirmId(msg.id)}
													className="size-9 rounded-xl border-border bg-background hover:bg-destructive/10 hover:border-destructive/40 text-muted-foreground hover:text-destructive transition-all cursor-pointer"
													title="Delete Menu"
												>
													<Trash2 className="size-4" />
												</Button>
											)}
										</div>
									</div>

									{/* Emoji Mapping List */}
									<div className="space-y-2.5">
										<span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider font-semibold block">
											Role Bindings ({msg.mappings.length})
										</span>
										<div className="space-y-2">
											{msg.mappings.map((m, idx) => {
												const targetRole = roles.find((r) => r.id === m.roleId);
												return (
													<div
														key={m.id || idx}
														className="flex items-center justify-between gap-3 p-3 rounded-xl bg-background/60 border border-border/60 hover:border-border transition-colors"
													>
														<div className="flex items-center gap-3 min-w-0">
															<span className="size-8 rounded-lg bg-card border border-border flex items-center justify-center text-lg shrink-0">
																{m.emoji}
															</span>
															<div className="min-w-0">
																<div className="flex items-center gap-2">
																	{targetRole && (
																		<span
																			className="size-2.5 rounded-full shrink-0"
																			style={{
																				backgroundColor: roleColor(
																					targetRole.color,
																				),
																			}}
																		/>
																	)}
																	<span className="text-xs font-mono font-semibold text-foreground truncate">
																		@{targetRole ? targetRole.name : m.roleId}
																	</span>
																</div>
																{m.description && (
																	<p className="text-[11px] text-muted-foreground truncate mt-0.5">
																		{m.description}
																	</p>
																)}
															</div>
														</div>
														<Badge
															variant="secondary"
															className="text-[10px] font-mono text-muted-foreground px-2 py-0.5 rounded-md shrink-0 border border-border"
														>
															Toggle
														</Badge>
													</div>
												);
											})}
										</div>
									</div>
								</div>

								{/* Footer Status */}
								<div className="pt-3 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground font-mono">
									<span>
										Status:{" "}
										{msg.messageId ? "Synced to Discord" : "Pending Bot Sync"}
									</span>
									{msg.messageId && (
										<Badge
											variant="outline"
											className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold rounded-full px-2 py-0.5"
										>
											Live Embed Active
										</Badge>
									)}
								</div>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}

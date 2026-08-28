import {
	db,
	eq,
	factionRoleMappings,
	guildConfigs,
	verificationLogs,
	verifiedUsers,
} from "@sentinel/database";
import type {
	BulkVerificationProgressData,
	GuildMemberVerificationInput,
	MemberVerificationAction,
	TornSchema,
	VerificationFailureResponse,
	VerificationRequest,
	VerificationSuccessResponse,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Verification");

type UserGenericResponse = TornSchema<"UserDiscordResponse"> &
	TornSchema<"UserFactionResponse"> &
	TornSchema<"UserProfileResponse">;

/**
 * Runs verification for a single Discord member in a guild using Drizzle ORM.
 * Calculates roles to add, roles to remove, and nickname formatting.
 */
export async function runVerificationJob(
	job: VerificationRequest,
	apiKeyOverride?: string,
): Promise<VerificationSuccessResponse | VerificationFailureResponse> {
	const finishLog = logger.time();

	try {
		// 1. Fetch Guild Configuration with Drizzle relational query
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, job.guildId),
		});

		if (!config) {
			finishLog();
			const errRes: VerificationFailureResponse = {
				guildId: job.guildId,
				channelId: job.channelId,
				discordId: job.discordId,
				error: { message: "Guild configuration not found." },
			};
			await db
				.insert(verificationLogs)
				.values({
					guildId: job.guildId,
					discordId: job.discordId,
					status: "failure",
					triggeredBy: job.triggeredBy || "user",
					rolesAdded: [],
					rolesRemoved: [],
					oldNickname: job.currentNickname,
					error: errRes.error.message,
				})
				.catch(() => {});
			return errRes;
		}

		// Fetch enabled faction mappings for guild
		const activeFactionMappings = await db.query.factionRoleMappings.findMany({
			where: eq(factionRoleMappings.guildId, job.guildId),
		});

		const enabledMappings = activeFactionMappings.filter((m) => m.enabled);

		// 2. Compile Managed & Protected Roles
		const managedRoles = new Set<string>();
		for (const id of config.verifiedRoleIds) {
			managedRoles.add(id);
		}
		for (const id of config.protectedRoleIds) {
			managedRoles.add(id);
		}
		for (const mapping of enabledMappings) {
			for (const id of mapping.memberRoleIds) {
				managedRoles.add(id);
			}
			for (const id of mapping.leaderRoleIds) {
				managedRoles.add(id);
			}
		}

		// 3. Fetch User via Centralized Torn API Client (using central key pool)
		let response: UserGenericResponse;
		try {
			response = (await tornApi.get("/user", {
				apiKey: apiKeyOverride,
				queryParams: {
					selections: ["discord", "faction", "profile"],
					id: job.discordId,
				},
			})) as UserGenericResponse;
		} catch (apiErr: unknown) {
			const errObj = apiErr as { code?: number; message?: string };
			const errMsg = errObj?.message || String(apiErr);
			logger.warn(`Torn API fetch failed for user ${job.discordId}:`, errMsg);

			if (
				errObj?.code === 6 ||
				errMsg.includes("not found") ||
				errMsg.includes("linked")
			) {
				const rolesToRemove = Array.from(managedRoles).filter((roleId) =>
					job.currentRoleIds.includes(roleId),
				);

				await db
					.delete(verifiedUsers)
					.where(eq(verifiedUsers.discordId, job.discordId));

				await db
					.insert(verificationLogs)
					.values({
						guildId: job.guildId,
						discordId: job.discordId,
						status: "success",
						triggeredBy: job.triggeredBy || "user",
						rolesAdded: [],
						rolesRemoved: rolesToRemove,
						oldNickname: job.currentNickname,
						newNickname: "",
					})
					.catch(() => {});

				finishLog();
				return {
					guildId: job.guildId,
					channelId: job.channelId,
					discordId: job.discordId,
					rolesToAdd: null,
					rolesToRemove: rolesToRemove.length > 0 ? rolesToRemove : null,
					newNickname: "",
				};
			}

			await db
				.insert(verificationLogs)
				.values({
					guildId: job.guildId,
					discordId: job.discordId,
					status: "failure",
					triggeredBy: job.triggeredBy || "user",
					rolesAdded: [],
					rolesRemoved: [],
					oldNickname: job.currentNickname,
					error: errMsg,
				})
				.catch(() => {});

			finishLog();
			return {
				guildId: job.guildId,
				channelId: job.channelId,
				discordId: job.discordId,
				error: { message: errMsg },
			};
		}

		if (!response?.profile?.id) {
			const errMsg = "Torn account not verified or profile unavailable.";
			await db
				.insert(verificationLogs)
				.values({
					guildId: job.guildId,
					discordId: job.discordId,
					status: "failure",
					triggeredBy: job.triggeredBy || "user",
					rolesAdded: [],
					rolesRemoved: [],
					oldNickname: job.currentNickname,
					error: errMsg,
				})
				.catch(() => {});

			finishLog();
			return {
				guildId: job.guildId,
				channelId: job.channelId,
				discordId: job.discordId,
				error: { message: errMsg },
			};
		}

		// 4. Target Roles Calculation
		const targetRoles = new Set<string>();
		const tornId = response.profile.id;
		const tornName = response.profile.name;
		const factionId = response.faction?.id || null;
		const factionTag = response.faction?.tag || null;
		const factionPosition = response.faction?.position || null;

		// Add base verified roles
		for (const id of config.verifiedRoleIds) {
			targetRoles.add(id);
		}

		// Check Faction Role Mappings
		let isInMappedFaction = false;
		if (factionId) {
			const mapping = enabledMappings.find((m) => m.factionId === factionId);
			if (mapping) {
				isInMappedFaction = true;
				for (const id of mapping.memberRoleIds) {
					targetRoles.add(id);
				}

				if (factionPosition === "Leader" || factionPosition === "Co-leader") {
					for (const id of mapping.leaderRoleIds) {
						targetRoles.add(id);
					}
				}
			}
		}

		// Protected Roles logic: Keep protected roles IF user is in a mapped faction
		if (isInMappedFaction) {
			for (const roleId of config.protectedRoleIds) {
				if (job.currentRoleIds.includes(roleId)) {
					targetRoles.add(roleId);
				}
			}
		}

		// 5. Update Verified User Record in DB via Drizzle (updating lastCheckedAt & createdAt)
		const now = new Date();
		await db
			.insert(verifiedUsers)
			.values({
				discordId: job.discordId,
				tornId,
				tornName,
				factionId,
				factionTag,
				lastCheckedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: verifiedUsers.discordId,
				set: {
					tornId,
					tornName,
					factionId,
					factionTag,
					lastCheckedAt: now,
					updatedAt: now,
				},
			});

		// 6. Format Nickname
		let template = config.nicknameTemplate || "[{tag}] {name} [{id}]";
		if (!factionTag) {
			template = template.replace("[{tag}]", "").replace("{tag}", "").trim();
		} else {
			template = template.replace("{tag}", factionTag);
		}
		const formattedNickname = template
			.replace("{name}", tornName)
			.replace("{id}", tornId.toString())
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 32);

		// 7. Calculate Diff
		const rolesToAdd = Array.from(targetRoles).filter(
			(roleId) => !job.currentRoleIds.includes(roleId),
		);

		const rolesToRemove = Array.from(managedRoles).filter(
			(roleId) =>
				!targetRoles.has(roleId) && job.currentRoleIds.includes(roleId),
		);

		const newNickname =
			formattedNickname === job.currentNickname ? null : formattedNickname;

		// 8. Create Verification Log
		await db
			.insert(verificationLogs)
			.values({
				guildId: job.guildId,
				discordId: job.discordId,
				status: "success",
				triggeredBy: job.triggeredBy || "user",
				rolesAdded: rolesToAdd,
				rolesRemoved: rolesToRemove,
				oldNickname: job.currentNickname,
				newNickname,
			})
			.catch(() => {});

		finishLog();
		return {
			guildId: job.guildId,
			channelId: job.channelId,
			discordId: job.discordId,
			rolesToAdd: rolesToAdd.length > 0 ? rolesToAdd : null,
			rolesToRemove: rolesToRemove.length > 0 ? rolesToRemove : null,
			newNickname,
		};
	} catch (error) {
		logger.error(
			`Error in runVerificationJob for user ${job.discordId}:`,
			error,
		);
		const errMsg =
			error instanceof Error ? error.message : "Internal worker error.";
		await db
			.insert(verificationLogs)
			.values({
				guildId: job.guildId,
				discordId: job.discordId,
				status: "failure",
				triggeredBy: job.triggeredBy || "user",
				rolesAdded: [],
				rolesRemoved: [],
				oldNickname: job.currentNickname,
				error: errMsg,
			})
			.catch(() => {});

		finishLog();
		return {
			guildId: job.guildId,
			channelId: job.channelId,
			discordId: job.discordId,
			error: { message: errMsg },
		};
	}
}

/**
 * Optimised bulk guild verification run.
 * Leverages `tornApi.executeBatch` to fetch mapped faction member lists in parallel across all registered guild API keys.
 * Processes ALL members (from Discord guild or DB fallback), calculating role additions/removals and nickname updates.
 * Emits real-time progress callbacks and member action batches for streaming back over IPC.
 */
export async function runBulkGuildVerification(
	guildId: string,
	triggeredBy: "cron" | "admin" | "user" = "cron",
	onProgress?: (progress: BulkVerificationProgressData) => Promise<void> | void,
	membersListInput?: GuildMemberVerificationInput[],
): Promise<{
	processed: number;
	total: number;
	updated: number;
	errors: number;
}> {
	const finishLog = logger.time();

	try {
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		const activeFactionMappings = await db.query.factionRoleMappings.findMany({
			where: eq(factionRoleMappings.guildId, guildId),
		});

		const enabledMappings = activeFactionMappings.filter((m) => m.enabled);

		if (!config) {
			logger.warn(
				`Guild configuration not found for bulk verification of guild ${guildId}`,
			);
			await onProgress?.({
				guildId,
				processed: 0,
				total: 0,
				updated: 0,
				errors: 1,
				status: "failed",
				message:
					"Guild configuration not found for bulk verification of this guild.",
			});
			return { processed: 0, total: 0, updated: 0, errors: 1 };
		}

		// Compile Managed & Protected Roles for the guild
		const managedRoles = new Set<string>();
		for (const id of config.verifiedRoleIds) {
			managedRoles.add(id);
		}
		for (const id of config.protectedRoleIds) {
			managedRoles.add(id);
		}
		for (const mapping of enabledMappings) {
			for (const id of mapping.memberRoleIds) {
				managedRoles.add(id);
			}
			for (const id of mapping.leaderRoleIds) {
				managedRoles.add(id);
			}
		}

		// Map: factionId -> Set of member Torn IDs, Map: factionId -> Set of Leader/Co-leader Torn IDs
		const factionMembersMap = new Map<number, Set<number>>();
		const factionLeadersMap = new Map<number, Set<number>>();

		// Fetch all mapped factions in parallel using tornApi.executeBatch across central key pool
		try {
			const factionResults = (await tornApi.executeBatch(
				"/faction",
				enabledMappings,
				(mapping) => ({
					queryParams: {
						selections: ["basic"],
						id: mapping.factionId,
					},
				}),
			)) as Array<{ members?: Record<string, { position?: string }> }>;

			for (let i = 0; i < enabledMappings.length; i++) {
				const mapping = enabledMappings[i];
				const facRes = factionResults[i];

				if (mapping && facRes?.members) {
					const membersSet = new Set<number>();
					const leadersSet = new Set<number>();

					for (const [idStr, memberData] of Object.entries(facRes.members)) {
						const tornId = parseInt(idStr, 10);
						if (!Number.isNaN(tornId)) {
							membersSet.add(tornId);
							if (
								memberData.position === "Leader" ||
								memberData.position === "Co-leader"
							) {
								leadersSet.add(tornId);
							}
						}
					}

					factionMembersMap.set(mapping.factionId, membersSet);
					factionLeadersMap.set(mapping.factionId, leadersSet);
				}
			}
		} catch (batchErr) {
			logger.warn(
				`Failed to batch fetch faction members for guild ${guildId}:`,
				batchErr,
			);
		}

		// Fetch all verified users in DB into a Map for O(1) lookups
		const dbVerifiedUsers = await db.query.verifiedUsers.findMany();
		const verifiedUsersMap = new Map<
			string,
			(typeof dbVerifiedUsers)[number]
		>();
		for (const u of dbVerifiedUsers) {
			verifiedUsersMap.set(u.discordId, u);
		}

		// Determine target member list (all guild members passed in, or DB fallback)
		const targetMembers: GuildMemberVerificationInput[] =
			membersListInput && membersListInput.length > 0
				? membersListInput
				: dbVerifiedUsers.map((u) => ({
						discordId: u.discordId,
						currentRoleIds: [],
						currentNickname: u.tornName,
					}));

		const total = targetMembers.length;
		let processed = 0;
		let updated = 0;
		let errors = 0;
		let pendingActions: MemberVerificationAction[] = [];

		// Emit initial progress event
		await onProgress?.({
			guildId,
			processed: 0,
			total,
			updated: 0,
			errors: 0,
			status: "running",
			message: `Starting bulk verification of ${total} members...`,
		});

		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const now = Date.now();

		for (const member of targetMembers) {
			processed++;
			try {
				const userInDb = verifiedUsersMap.get(member.discordId);
				const checkedAt = userInDb?.lastCheckedAt
					? new Date(userInDb.lastCheckedAt).getTime()
					: 0;
				const isStale = !userInDb || now - checkedAt > SEVEN_DAYS_MS;

				// If user is not in DB or link check is stale (>7 days), do full Torn API verification
				if (!userInDb || isStale) {
					const res = await runVerificationJob({
						guildId,
						channelId: "",
						discordId: member.discordId,
						currentRoleIds: member.currentRoleIds,
						currentNickname: member.currentNickname,
						triggeredBy,
					});

					if ("error" in res && res.error) {
						errors++;
					} else if ("rolesToAdd" in res) {
						const hasChanges =
							(res.rolesToAdd && res.rolesToAdd.length > 0) ||
							(res.rolesToRemove && res.rolesToRemove.length > 0) ||
							res.newNickname !== null;

						if (hasChanges) {
							updated++;
							pendingActions.push({
								discordId: member.discordId,
								rolesToAdd: res.rolesToAdd,
								rolesToRemove: res.rolesToRemove,
								newNickname: res.newNickname,
							});
						}
					}
				} else {
					// Fast in-memory verification using cached verified user data & pre-fetched faction maps
					let userFactionId: number | null = null;
					let isLeaderOrCoLeader = false;

					for (const [factionId, membersSet] of factionMembersMap) {
						if (membersSet.has(userInDb.tornId)) {
							userFactionId = factionId;
							const leadersSet = factionLeadersMap.get(factionId);
							if (leadersSet?.has(userInDb.tornId)) {
								isLeaderOrCoLeader = true;
							}
							break;
						}
					}

					// Compute target roles
					const targetRoles = new Set<string>();
					for (const id of config.verifiedRoleIds) {
						targetRoles.add(id);
					}

					let isInMappedFaction = false;
					if (userFactionId) {
						const mapping = enabledMappings.find(
							(m) => m.factionId === userFactionId,
						);
						if (mapping) {
							isInMappedFaction = true;
							for (const id of mapping.memberRoleIds) {
								targetRoles.add(id);
							}
							if (isLeaderOrCoLeader) {
								for (const id of mapping.leaderRoleIds) {
									targetRoles.add(id);
								}
							}
						}
					}

					// Protected roles: keep protected roles if user is in a mapped faction
					if (isInMappedFaction) {
						for (const roleId of config.protectedRoleIds) {
							if (member.currentRoleIds.includes(roleId)) {
								targetRoles.add(roleId);
							}
						}
					}

					// Format nickname
					let template = config.nicknameTemplate || "[{tag}] {name} [{id}]";
					if (!userInDb.factionTag) {
						template = template
							.replace("[{tag}]", "")
							.replace("{tag}", "")
							.trim();
					} else {
						template = template.replace("{tag}", userInDb.factionTag);
					}
					const formattedNickname = template
						.replace("{name}", userInDb.tornName)
						.replace("{id}", userInDb.tornId.toString())
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 32);

					// Calculate diffs
					const rolesToAdd = Array.from(targetRoles).filter(
						(roleId) => !member.currentRoleIds.includes(roleId),
					);
					const rolesToRemove = Array.from(managedRoles).filter(
						(roleId) =>
							!targetRoles.has(roleId) &&
							member.currentRoleIds.includes(roleId),
					);
					const newNickname =
						formattedNickname === member.currentNickname
							? null
							: formattedNickname;

					let factionChanged = false;
					if (userInDb.factionId !== userFactionId) {
						await db
							.update(verifiedUsers)
							.set({
								factionId: userFactionId,
								updatedAt: new Date(),
							})
							.where(eq(verifiedUsers.discordId, userInDb.discordId));
						factionChanged = true;
					}

					const hasChanges =
						rolesToAdd.length > 0 ||
						rolesToRemove.length > 0 ||
						newNickname !== null ||
						factionChanged;

					if (hasChanges) {
						updated++;
						pendingActions.push({
							discordId: member.discordId,
							rolesToAdd: rolesToAdd.length > 0 ? rolesToAdd : null,
							rolesToRemove: rolesToRemove.length > 0 ? rolesToRemove : null,
							newNickname,
						});

						await db
							.insert(verificationLogs)
							.values({
								guildId,
								discordId: member.discordId,
								status: "success",
								triggeredBy,
								rolesAdded: rolesToAdd,
								rolesRemoved: rolesToRemove,
								oldNickname: member.currentNickname,
								newNickname,
							})
							.catch(() => {});
					}
				}
			} catch (memberErr) {
				logger.error(
					`Error bulk verifying member ${member.discordId}:`,
					memberErr,
				);
				errors++;
			}

			// Stream progress update every 10 users or upon reaching the end
			if (processed % 10 === 0 || processed === total) {
				const actionsToSend =
					pendingActions.length > 0 ? [...pendingActions] : undefined;
				pendingActions = [];

				await onProgress?.({
					guildId,
					processed,
					total,
					updated,
					errors,
					status: "running",
					actions: actionsToSend,
				});
			}
		}

		// Emit completed event with any remaining actions
		const finalActions =
			pendingActions.length > 0 ? [...pendingActions] : undefined;

		await onProgress?.({
			guildId,
			processed,
			total,
			updated,
			errors,
			status: "completed",
			actions: finalActions,
			message: `Bulk verification completed: ${processed} processed, ${updated} updated, ${errors} errors.`,
		});

		finishLog();
		return { processed, total, updated, errors };
	} catch (err) {
		logger.error(
			`Error in runBulkGuildVerification for guild ${guildId}:`,
			err,
		);
		await onProgress?.({
			guildId,
			processed: 0,
			total: 0,
			updated: 0,
			errors: 1,
			status: "failed",
			message: err instanceof Error ? err.message : String(err),
		});
		finishLog();
		return { processed: 0, total: 0, updated: 0, errors: 1 };
	}
}

import { RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

interface SubversiveDibsConfig {
	enabled: boolean;
	channelId: string | null;
	claimLeadTime: number;
	maxDibsPerPerson: number;
	postHospTimeoutSeconds: number;
	autoDeleteOnDowned: boolean;
}

interface GuildChannel {
	id: string;
	name: string;
}

export function DibsConfigPage({
	guildId: _guildId,
}: {
	guildId?: string;
} = {}) {
	const [config, setConfig] = useState<SubversiveDibsConfig>({
		enabled: true,
		channelId: null,
		claimLeadTime: 5,
		maxDibsPerPerson: 1,
		postHospTimeoutSeconds: 20,
		autoDeleteOnDowned: true,
	});
	const [channels, setChannels] = useState<GuildChannel[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	const fetchData = useCallback(async () => {
		try {
			const [cfgRes, chRes] = await Promise.all([
				fetch("/v2/subversive/dibs-config"),
				fetch("/v2/subversive/guild-channels"),
			]);

			if (cfgRes.ok) {
				const cfgData = (await cfgRes.json()) as {
					config: SubversiveDibsConfig;
				};
				if (cfgData.config) {
					setConfig(cfgData.config);
				}
			}

			if (chRes.ok) {
				const chData = (await chRes.json()) as { channels: GuildChannel[] };
				setChannels(chData.channels ?? []);
			}
		} catch (err) {
			console.error("Failed loading dibs data:", err);
			toast.error("Failed to load dibs configuration.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch("/v2/subversive/dibs-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) {
				const err = (await res.json()) as { error?: string };
				throw new Error(err.error || "Failed to update configuration");
			}

			const data = (await res.json()) as { config: SubversiveDibsConfig };
			setConfig(data.config);
			toast.success("War Dibs settings updated successfully.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save settings.",
			);
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div>
					<Skeleton className="h-8 w-48 mb-2" />
					<Skeleton className="h-4 w-96" />
				</div>
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-6 max-w-5xl">
			<Card className="border-border bg-card">
				<CardHeader>
					<CardTitle className="text-base font-medium flex items-center gap-2">
						Dibs Settings
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Enable War Dibs</div>
						</div>
						<Switch
							checked={config.enabled}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({ ...prev, enabled: checked }))
							}
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="space-y-2">
							<label
								htmlFor="discord-dibs-channel"
								className="text-xs font-mono font-medium text-foreground"
							>
								Discord Dibs Channel
							</label>
							<Select
								value={config.channelId ?? "none"}
								onValueChange={(val) =>
									setConfig((prev) => ({
										...prev,
										channelId: val === "none" ? null : val,
									}))
								}
							>
								<SelectTrigger id="discord-dibs-channel" className="w-full">
									<SelectValue placeholder="Select target channel" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">
										No channel selected (Disabled)
									</SelectItem>
									{channels.map((ch) => (
										<SelectItem key={ch.id} value={ch.id}>
											#{ch.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="claim-lead-time"
								className="text-xs font-mono font-medium text-foreground"
							>
								Claim Lead Time (Minutes)
							</label>
							<Input
								id="claim-lead-time"
								type="number"
								min={1}
								max={30}
								value={config.claimLeadTime}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										claimLeadTime: Math.max(1, Number(e.target.value) || 1),
									}))
								}
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="max-dibs-per-person"
								className="text-xs font-mono font-medium text-foreground"
							>
								Max Dibs Per Person
							</label>
							<Input
								id="max-dibs-per-person"
								type="number"
								min={1}
								max={5}
								value={config.maxDibsPerPerson}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										maxDibsPerPerson: Math.max(1, Number(e.target.value) || 1),
									}))
								}
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="post-hosp-lock"
								className="text-xs font-mono font-medium text-foreground"
							>
								Post-Hospital Lock Duration (Seconds)
							</label>
							<Input
								id="post-hosp-lock"
								type="number"
								min={5}
								max={120}
								value={config.postHospTimeoutSeconds}
								onChange={(e) =>
									setConfig((prev) => ({
										...prev,
										postHospTimeoutSeconds: Math.max(
											5,
											Number(e.target.value) || 20,
										),
									}))
								}
							/>
						</div>
					</div>

					<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
						<div className="space-y-0.5">
							<div className="text-sm font-medium">Auto-Delete on Downed</div>
						</div>
						<Switch
							checked={config.autoDeleteOnDowned}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({ ...prev, autoDeleteOnDowned: checked }))
							}
						/>
					</div>
				</CardContent>
				<CardFooter className="flex justify-end border-t border-border pt-4">
					<Button onClick={handleSave} disabled={saving} className="gap-2">
						{saving ? (
							<RefreshCw className="size-4 animate-spin" />
						) : (
							<Save className="size-4" />
						)}
						Save Changes
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}

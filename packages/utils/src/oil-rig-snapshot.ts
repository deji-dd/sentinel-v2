/**
 * The company snapshot shapes the engines consume.
 *
 * These used to live in `oil-rig-briefing.ts`, which meant the *analysis* could
 * not be described without importing the *delivery* module. They live here so the
 * engines, the analysis orchestrator, the briefing and the API all share one
 * definition, and `oil-rig-briefing.ts` re-exports them for existing callers.
 */

export interface EmployeeSnapshot {
	id: number;
	name: string;
	position?: { id?: number; name?: string } | null;
	days_in_company: number;
	wage: number;
	stats: {
		manual_labor: number;
		intelligence: number;
		endurance: number;
	};
	effectiveness: {
		working_stats: number;
		settled_in: number;
		director_education: number;
		addiction: number;
		inactivity: number;
		total: number;
	};
}

export interface CompanySnapshot {
	profile: {
		/** Torn company id. Present on live responses; absent on hand-built ones. */
		id?: number;
		name: string;
		rating: number;
		funds: number;
		efficiency: number;
		environment: number;
		popularity: number;
		income: { daily: number; weekly: number };
		customers: { daily: number; weekly: number };
		employees: { hired: number; capacity: number };
		upgrades: { storage_capacity?: number };
		advertisement_budget: number;
	};
	stock: Array<{
		name: string;
		price: number;
		in_stock: number;
		sold_amount: number;
		sold_worth: number;
	}>;
	employees: EmployeeSnapshot[];
}

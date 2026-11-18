// The support API lives on another host. In production this is a real service.
export const API = 'https://api.orbit-support.example';

export interface Me { id: string; name: string; role: 'admin' | 'agent' }
export interface Account { name: string; plan: string; status: 'active' | 'past_due' | 'suspended'; seats: number }
export interface Ticket { id: string; subject: string; customer: string; priority: 'low' | 'normal' | 'urgent'; status: 'open' | 'closed' }

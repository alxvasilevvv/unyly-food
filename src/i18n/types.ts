/** Vocabulary the demo request parser needs for one language. Every list may be empty. */
export interface LangPack {
  /** Seven example requests, same order and meaning as the English ones. */
  examples: string[];
  service_words: Record<'ride' | 'express' | 'flowers' | 'pharmacy' | 'cakes' | 'groceries', string[]>;
  route: { from: string[]; to: string[] };
  party: { cue: string[]; people: string[] };
  number_words: Record<string, number>;
  budget_cues: string[];
  currency_words: string[];
  negation: string[];
  allergy_cue: string[];
  allergens: Record<'peanut' | 'shellfish' | 'milk' | 'egg' | 'wheat' | 'soy' | 'fish' | 'sesame', string[]>;
  diet: Record<'vegan' | 'vegetarian' | 'halal' | 'no_pork', string[]>;
  meal_words: string[];
  place_aliases: Record<string, string[]>;
  airport_words: string[];
  weight_units: string[];
  shop_items: Record<string, string[]>;
}

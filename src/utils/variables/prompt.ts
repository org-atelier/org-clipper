// The interpreter/prompt feature has been removed; {{prompt:...}} variables
// now resolve to an empty string so old templates still render cleanly.
export async function processPrompt(_match: string, _variables: { [key: string]: string }, _currentUrl: string): Promise<string> {
	return '';
}

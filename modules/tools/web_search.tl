{
	"name": "web_search",
	"description": "Search the web via DuckDuckGo's Instant Answer API and return the top results",
	"arguments": [
		{
			"type": "string",
			"name": "query",
			"description": "The search that you want to make",
			"disallow": []
		}
	]
}¤

set var results to call(make_search, args.query)
set var topics to results.RelatedTopics
if topics == null then
return([])
close
return(Array.slice(topics, 0, 5))

fn make_search with (query: string) do
set var req to http.get("https://api.duckduckgo.com/?q={1}&format={2}".format([query, "json"]))
--= json.to formats the text response into an object, .from does the opposite
return(json.to(req.response))
close

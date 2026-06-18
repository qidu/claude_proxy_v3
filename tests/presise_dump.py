import json                                                                                                                                                                           
with open('model_proxy_tokens.jsonl', 'r') as f:      
    lines = f.readlines()                                                                                                                                                       
    with open('model_proxy_tokens.jsonl', 'w') as f:                                    
        for line in lines:                                              
            rec = json.loads(line)                      
            if 'heatmapEvents' in rec:                                  
                for e in rec['heatmapEvents']:                                      
                    if e['timestamp'] > 1e12:  # detect ms precision                    
                        e['timestamp'] = int(e['timestamp'] / 1000)                         
            f.write(json.dumps(rec) + '\n')  

select cron.schedule('smithton-food-safety-app-evidence','*/10 * * * *',
 $job$ select net.http_post(
 url := 'https://gyzxsugnlobxlvqjevhh.supabase.co/functions/v1/food-safety-collector',
 headers := jsonb_build_object('Content-Type','application/json','x-scheduler-secret',(select scheduler_secret from public.toc_push_config where id=1)),
 body := '{"action":"collect"}'::jsonb, timeout_milliseconds := 120000
 ) $job$);

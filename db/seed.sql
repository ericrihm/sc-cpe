-- Rule v1: message length >= 3 chars (stripped), not pure emoji, publishedAt
-- between actualStartTime+15min and actualEndTime-15min. Anchored to YT API
-- actual times, NOT wall clock. Each attendance row carries this version.
INSERT INTO kv (k, v, updated_at) VALUES
    ('rule_version.current', '1', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ('rule_version.1.min_msg_len', '3', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ('rule_version.1.pre_start_grace_min', '15', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ('rule_version.1.pre_end_grace_min', '15', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ('rule_version.1.cpe_per_day', '0.5', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ('rule_version.1.finalize_settle_min', '5', strftime('%Y-%m-%dT%H:%M:%SZ','now'));

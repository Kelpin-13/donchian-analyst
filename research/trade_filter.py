"""
Trade filter (meta-labelling): can a model, looking only at what the EA knew when a trade fired,
tell GoldIntraday's good setups from its bad ones well enough to skip the bad?

    node research/trade_features.js          # once: data/trade_features.csv from the tester journals
    py research/trade_filter.py [--csv path]

Needs Python 3 with lightgbm, numpy and pandas (py -m pip install lightgbm pandas).

Walk-forward, never testing on data the model saw:
  test 1: train on 2008-14, test on 2015-22;   test 2: train on 2008-22, test on 2023-26.
The model (LightGBM, small and fixed in advance, no tuning) predicts each trade's R; trades it scores
below the threshold are skipped. The threshold is fixed before testing: predicted R below 0, plus
for information the bottom 20% / 30% of the training set's own scores.
Rule to pass (written before the run): in BOTH tests the skipped trades lost money in total AND the
money's growth / worst drawdown got better. IC = rank correlation between the score and the trade's R
(as Qlib reports it); "noise" = the same model trained on shuffled R, 30 times, to show what luck gives.

First run (16 Oct 2026, tester runs with weights 0.5/1/1/1/0.5/1): FAIL. IC +0.039 (2015-22, inside
luck's 0.062) and +0.067 (2023-26, beyond luck's 0.057), positive for every strategy in both. Skipping
predicted R < 0 rescued 2015-22 (+2.8% / DD 17.7% -> +24.2% / 9.1%) but in 2023-26 skipped trades that
made +33.5 R (+31.2% / 6.6% -> +23.7% / 4.5%). Not used live.
"""
import argparse
import os
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
FEATURES = ['strat_code', 'side', 'hour', 'dow', 'risk_atr', 'move_open', 'gap', 'yrange', 'dtrange', 'atr_pct',
            'atr_ratio', 'trend20', 'vs_yhigh', 'vs_ylow', 'news_day', 'mins_to_news', 'mins_since_news',
            'strat_last10', 'all_last20']
STRATS = ['NY_ORB', 'ASIAN_NARROW', 'DUAL_THRUST', 'R_BREAKER', 'MOM_16', 'MOM_20']
PARAMS = dict(objective='regression', learning_rate=0.02, num_leaves=8, min_data_in_leaf=200, bagging_fraction=0.8,
              bagging_freq=1, feature_fraction=0.8, lambda_l2=10.0, seed=7, verbose=-1)
ROUNDS = 300
TESTS = [(['2008-14'], '2015-22'), (['2008-14', '2015-22'], '2023-26')]


def fit(train, label):
    data = lgb.Dataset(train[FEATURES], label.clip(-2, 5), categorical_feature=['strat_code'])
    return lgb.train(PARAMS, data, num_boost_round=ROUNDS)


def ic(score, r):
    return pd.Series(np.asarray(score)).corr(pd.Series(np.asarray(r)), method='spearman')   # by position, not index


def money(trades):
    """Growth and worst drawdown (%) of one era's closed trades in exit order, from its starting equity."""
    t = trades.sort_values('exit_time')
    start = t['eq0'].iloc[0] if len(t) else 10000.0
    eq = start + t['usd'].cumsum()
    path = np.concatenate([[start], eq.values])
    peak = np.maximum.accumulate(path)
    return (path[-1] / start - 1) * 100, ((peak - path) / peak).max() * 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', default=os.path.join(HERE, '..', 'data', 'trade_features.csv'))
    args = ap.parse_args()
    if not os.path.exists(args.csv):
        sys.exit('No ' + args.csv + ': run node research/trade_features.js first.')
    df = pd.read_csv(args.csv)
    df['strat_code'] = pd.Categorical(df['strat'], categories=STRATS).codes
    df['usd'] = df['usd'].fillna(0.0)
    print('Trades: ' + ', '.join(f"{e} {n}" for e, n in df.groupby('era').size().items()))
    print('Model: LightGBM regression on R (clipped -2..5 for training), ' + str(len(FEATURES)) + ' features, fixed settings')

    verdicts = []
    for train_eras, test_era in TESTS:
        train, test = df[df['era'].isin(train_eras)], df[df['era'] == test_era].copy()
        model = fit(train, train['r'])
        test['score'] = model.predict(test[FEATURES])
        fitted = model.predict(train[FEATURES])
        print(f"\n=== Train {' + '.join(train_eras)} ({len(train)} trades) -> test {test_era} ({len(test)} trades)")

        rng = np.random.default_rng(11)
        noise = []
        for _ in range(30):
            shuffled = fit(train, pd.Series(rng.permutation(train['r'].values), index=train.index))
            value = ic(shuffled.predict(test[FEATURES]), test['r'])
            noise.append(0.0 if np.isnan(value) else value)          # learned nothing: one flat score
        print(f"IC on the test era: {ic(test['score'], test['r']):+.3f}   (shuffled-R noise: mean {np.mean(noise):+.3f}, "
              f"95% of luck below {np.percentile(np.abs(noise), 95):.3f})")
        print('IC by strategy: ' + ', '.join(f"{s} {ic(g['score'], g['r']):+.3f}" for s, g in test.groupby('strat')))

        test['fifth'] = pd.qcut(test['score'].rank(method='first'), 5, labels=['1 worst', '2', '3', '4', '5 best'])
        print('Average R by model score (test era, fifths): ' + ', '.join(
            f"{q} {g['r'].mean():+.3f}" for q, g in test.groupby('fifth', observed=True)))

        g0, d0 = money(test)
        print(f"{'policy':34}{'skipped':>8}{'skipped R':>11}{'kept R':>9}{'growth':>9}{'worst DD':>10}{'growth/DD':>11}")
        print(f"{'no filter':34}{0:>8}{0:>11.1f}{test['r'].sum():>9.1f}{g0:>8.1f}%{d0:>9.1f}%{g0 / d0:>11.2f}")
        policies = [('skip predicted R < 0 (the rule)', 0.0),
                    ('skip bottom 20% of training scores', np.percentile(fitted, 20)),
                    ('skip bottom 30% of training scores', np.percentile(fitted, 30))]
        for name, cut in policies:
            skip = test['score'] < cut
            g, d = money(test[~skip])
            print(f"{name:34}{int(skip.sum()):>8}{test.loc[skip, 'r'].sum():>11.1f}{test.loc[~skip, 'r'].sum():>9.1f}"
                  f"{g:>8.1f}%{d:>9.1f}%{(g / d if d else float('nan')):>11.2f}")
            if name.endswith('(the rule)'):
                verdicts.append(test.loc[skip, 'r'].sum() < 0 and g / d > g0 / d0)
                # Skipping trades lowers drawdown whichever are skipped: the same number skipped at random, 200 times.
                ratios = []
                for _ in range(200):
                    rg, rd = money(test.drop(rng.choice(test.index, int(skip.sum()), replace=False)))
                    ratios.append(rg / rd if rd else np.nan)
                rule_ratio = g / d if d else np.nan
                print(f"{'  same number skipped at random':34}{int(skip.sum()):>8}{'':>11}{'':>9}{'':>19}"
                      f"{np.nanmedian(ratios):>11.2f}  (median of 200; the rule beats {np.mean(np.array(ratios) < rule_ratio):.0%} of them)")
        # Exploratory, chosen after seeing the first run (so not evidence): half size instead of skipping.
        half = test.copy()
        half.loc[half['score'] < 0, 'usd'] *= 0.5
        g, d = money(half)
        print(f"{'half size if predicted R < 0 *':34}{'':>8}{'':>11}{'':>9}{g:>8.1f}%{d:>9.1f}%{g / d:>11.2f}"
              f"   * exploratory, added after the first run")
        print('Skipped by strategy (the rule): ' + ', '.join(
            f"{s} {int((g['score'] < 0).sum())}/{len(g)} ({g.loc[g['score'] < 0, 'r'].sum():+.1f} R)" for s, g in test.groupby('strat')))
        if test_era == TESTS[-1][1]:
            imp = pd.Series(model.feature_importance('gain'), index=FEATURES)
            print('What the model leans on (share of gain): ' + ', '.join(
                f"{k} {v:.0%}" for k, v in (imp / imp.sum()).sort_values(ascending=False).head(8).items()))

    print('\nVerdict: ' + ('PASS - the filter helped in both tests' if all(verdicts) else
                           'FAIL - the filter did not help in both tests (' + ', '.join(
                               f"{t[1]} {'helped' if v else 'did not help'}" for t, v in zip(TESTS, verdicts)) + ')'))


if __name__ == '__main__':
    main()
